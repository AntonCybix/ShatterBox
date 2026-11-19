import { Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Conversation } from './assistant.js';
import { activeBots, bots, config, log } from './config.js';
import { strings } from './i18n.js';
import { warmUp } from './llm.js';
import { preloadStt } from './speech.js';
import { setStatus, startStatusServer } from './status.js';
import { VoiceSession, prewarmPhrases } from './voice.js';

const idle = () => setInterval(() => {}, 2 ** 30); // håll containern vid liv utan att starta om i loop
const clients = [];

startStatusServer();

if (!activeBots.length) {
  log('Ingen karaktär ska in på Discord (ingen token, eller alla är lokala) - inga Discord-botar startas.');
  log('Lägg in en token i kontrollpanelen eller med "shatterbox edit", och starta sedan om botarna.');
  log('Lokala karaktärer pratar du med i terminalen: shatterbox talk');
  idle();
} else {
  for (const bot of bots.filter((b) => b.mode === 'local')) log(`[${bot.name}] är lokal och startas inte på Discord`);
  for (const bot of bots.filter((b) => b.mode === 'discord' && !b.token)) {
    log(`[${bot.name}] saknar token (${bot.index === 1 ? 'DISCORD_TOKEN' : `BOT${bot.index}_DISCORD_TOKEN`}) och startas inte`);
  }
  preloadStt();
  warmUp()
    .then(() => log(`${config.model} är laddad i Ollama`))
    .catch((error) => log(`VARNING: når inte Ollama (${error.message}). Är Ollama igång på datorn?`));
  for (const bot of activeBots) startBot(bot);

  process.on('unhandledRejection', (error) => log(`ohanterat fel: ${error?.stack ?? error}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      Promise.allSettled(clients.map((entry) => entry.shutdown())).finally(() => process.exit(0));
    });
  }
}

/** Startar en karaktär som en egen Discord-bot. */
function startBot(bot) {
  const t = strings(bot.language);
  const tag = `[${bot.name}]`;
  const greeting = bot.greeting || t.greeting;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const sessions = new Map(); // guildId -> VoiceSession
  const conversations = new Map(); // guildId -> Conversation
  clients.push({
    shutdown: async () => {
      for (const session of sessions.values()) session.destroy();
      await client.destroy();
    },
  });

  const conversationFor = (guildId) => {
    if (!conversations.has(guildId)) conversations.set(guildId, new Conversation(bot));
    return conversations.get(guildId);
  };

  const commands = [
    new SlashCommandBuilder().setName('join').setDescription(t.commands.join),
    new SlashCommandBuilder().setName('leave').setDescription(t.commands.leave),
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription(t.commands.ask)
      .addStringOption((option) =>
        option.setName(t.commands.askOption).setDescription(t.commands.askOptionDescription).setRequired(true),
      ),
    new SlashCommandBuilder().setName('reset').setDescription(t.commands.reset),
  ].map((command) => command.toJSON());

  const register = (guild) =>
    guild.commands
      .set(commands)
      .catch((error) => log(`${tag} kunde inte registrera kommandon i ${guild.name}: ${error.message}`));

  async function join(channel) {
    const guildId = channel.guild.id;
    const existing = sessions.get(guildId);
    if (existing && !existing.destroyed) {
      if (existing.channelId === channel.id) return existing;
      existing.destroy();
    }
    const session = new VoiceSession(channel, bot, conversationFor(guildId));
    session.onClosed = () => {
      if (sessions.get(guildId) === session) sessions.delete(guildId);
      setStatus(bot, { voice: null });
      log(`${tag} lämnade #${channel.name}`);
    };
    sessions.set(guildId, session);
    try {
      await session.connect();
    } catch (error) {
      session.destroy();
      sessions.delete(guildId);
      throw error;
    }
    log(`${tag} ansluten till #${channel.name} i ${channel.guild.name}`);
    setStatus(bot, { voice: { guild: channel.guild.name, channel: channel.name } });
    // Förbered standardfraserna med aktuell röst, och hälsa sedan.
    prewarmPhrases(bot)
      .then(() => session.announce(greeting))
      .catch(() => {});
    return session;
  }

  function leave(guildId) {
    const session = sessions.get(guildId);
    if (!session) return false;
    session.destroy();
    sessions.delete(guildId);
    return true;
  }

  const guildNames = () => [...client.guilds.cache.values()].map((guild) => guild.name);

  client.once(Events.ClientReady, (ready) => {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${ready.user.id}&scope=bot+applications.commands&permissions=36703232`;
    log(`${tag} inloggad som ${ready.user.tag} (${t.languageName})`);
    log(`${tag} bjud in med: ${inviteUrl}`);
    setStatus(bot, { loggedIn: true, tag: ready.user.tag, inviteUrl, guilds: guildNames(), error: null });
    for (const guild of ready.guilds.cache.values()) register(guild);
    prewarmPhrases(bot);
  });

  client.on(Events.GuildCreate, (guild) => {
    register(guild);
    setStatus(bot, { guilds: guildNames() });
  });
  client.on(Events.GuildDelete, () => setStatus(bot, { guilds: guildNames() }));

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guild = newState.guild;

    // Följ med ägaren in i röstkanaler.
    if (
      bot.autoJoin &&
      bot.ownerId &&
      newState.id === bot.ownerId &&
      newState.channel &&
      newState.channelId !== oldState.channelId
    ) {
      try {
        await join(newState.channel);
      } catch (error) {
        log(`${tag} kunde inte gå med i #${newState.channel.name}: ${error.message}`);
      }
    }

    // Lämna när inga människor är kvar.
    const session = sessions.get(guild.id);
    if (session && !session.destroyed) {
      const channel = guild.channels.cache.get(session.channelId);
      const humans = channel?.members?.filter((member) => !member.user.bot).size ?? 0;
      if (humans === 0) leave(guild.id);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
    const guildId = interaction.guildId;
    try {
      if (interaction.commandName === 'join') {
        const channel = interaction.member?.voice?.channel;
        if (!channel) {
          await interaction.reply({ content: t.replies.needVoice, flags: MessageFlags.Ephemeral });
          return;
        }
        if (!channel.joinable || !channel.speakable) {
          await interaction.reply({ content: t.replies.noPermission, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await join(channel);
        await interaction.editReply(t.replies.joined(channel.name));
      } else if (interaction.commandName === 'leave') {
        const left = leave(guildId);
        await interaction.reply({
          content: left ? t.replies.bye : t.replies.notInVoice,
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.commandName === 'reset') {
        conversationFor(guildId).reset();
        await interaction.reply({ content: t.replies.forgot, flags: MessageFlags.Ephemeral });
      } else if (interaction.commandName === 'ask') {
        const question = interaction.options.getString(t.commands.askOption, true);
        await interaction.deferReply();
        const session = sessions.get(guildId);
        const speaking = session && !session.destroyed;
        const turn = speaking ? session.startTurn(question) : null;
        const name = interaction.member?.displayName ?? interaction.user.username;
        log(`${tag} ${name} (text): ${question}`);
        try {
          const answer = await conversationFor(guildId).ask({
            userName: name,
            userText: question,
            signal: turn?.abort.signal,
            onSentence: (sentence) => turn && session.say(sentence, turn),
            onSearch: (query) => log(`${tag}   söker: ${query}`),
          });
          log(`${tag} ${bot.name}: ${answer}`);
          await interaction.editReply(`**${question}**\n${answer || t.replies.noAnswer}`.slice(0, 2000));
        } finally {
          if (turn) session.endTurn(turn).catch(() => {});
        }
      }
    } catch (error) {
      log(`${tag} fel i /${interaction.commandName}: ${error.message}`);
      const content = t.replies.error(error.message).slice(0, 1900);
      if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.login(bot.token).catch((error) => {
    setStatus(bot, { error: `Kunde inte logga in på Discord: ${error.message}` });
    log(`${tag} kunde inte logga in på Discord: ${error.message}`);
    log(`${tag} kontrollera token i .env (${bot.index === 1 ? 'DISCORD_TOKEN' : `BOT${bot.index}_DISCORD_TOKEN`})`);
  });
}
