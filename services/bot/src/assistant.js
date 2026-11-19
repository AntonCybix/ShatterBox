import { config } from './config.js';
import { respond } from './llm.js';
import { learn, recall } from './memory.js';

/** Ett samtal med minne för en karaktär (ett per bot och Discord-server). */
export class Conversation {
  constructor(bot) {
    this.bot = bot;
    this.history = [];
  }

  reset() {
    this.history = [];
  }

  #remember(userText, answer) {
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: answer });
    const max = config.historyTurns * 2;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  /**
   * Frågar språkmodellen. onSentence anropas för varje färdig mening,
   * onSearch när modellen bestämmer sig för att söka på webben.
   */
  async ask({ userName, userId, userText, signal, onSentence, onSearch }) {
    const spoken = [];
    const user = { id: userId ?? null, name: userName };
    try {
      const answer = await respond({
        bot: this.bot,
        history: this.history,
        userName,
        userText,
        memory: recall(this.bot, user),
        signal,
        onSentence: (sentence) => {
          spoken.push(sentence);
          onSentence?.(sentence);
        },
        onSearch,
      });
      if (answer) this.#remember(userText, answer);
      learn(this.bot, user, userText); // i bakgrunden, väntar inte på den
      return answer;
    } catch (error) {
      // Avbruten mitt i svaret: kom ihåg det som faktiskt hann sägas.
      if (signal?.aborted && spoken.length) this.#remember(userText, `${spoken.join(' ')} …`);
      throw error;
    }
  }
}
