// Allt som beror på vilket språk en karaktär pratar: fraser, promptar och kommandotexter.

const SV = {
  languageName: 'svenska',
  searchLocale: 'sv-SE',
  dateLocale: 'sv-SE',
  greeting: 'Hej! Nu är jag med.',
  filler: 'Jag kollar upp det.',
  apology: 'Förlåt, något gick fel.',
  // Frågor där dagens datum eller klockslag behövs. Den lilla modellen rabblar gärna upp
  // datumet i varje svar om det står i prompten, så det tas bara med när det är relevant.
  needsClock:
    /\b(klockan|klockslag|vilken\s+tid|hur\s+dags|datum|datumet|veckodag|vilken\s+dag|vilket\s+år|vilken\s+månad|vilken\s+vecka|hur\s+många\s+dagar|hur\s+länge\s+(?:sedan|kvar|till|är\s+det))\b/i,

  router: ({ date, year, guide }) =>
    [
      'Du avgör om en röstassistent måste söka på webben för att kunna svara på användarens senaste fråga.',
      '',
      'Sätt search till true när frågan gäller något som kan ha ändrats eller som kräver färska uppgifter: väder, nyheter, aktuella händelser, priser och kurser, sportresultat, öppettider, vem som har en post just nu (till exempel statsminister, president eller vd), vinnare av tävlingar, nya produkter och annat du inte säkert vet.',
      'Sätt search till false för hälsningar och småprat, allmänbildning som inte ändras, förklaringar av begrepp, matematik, språkfrågor och frågor om själva samtalet.',
      guide
        ? [
            `Assistenten är en guide för ${guide}. Sätt search till true för alla sakfrågor om spelet: var något finns, uppdrag, klasser, förmågor, talanger, föremål, yrken, instanser, raider och strategier.`,
            'Skriv då query på engelska med spelets egna engelska namn, kort och rakt på det som efterfrågas. Ta bara med spelarens klass eller level när svaret beror på det, och aldrig assistentens namn.',
            'clarify: om frågan syftar på något som inte framgår av samtalet, till exempel "dit", "den" eller "det där" utan att det sagts vad som menas, skriver du en kort motfråga på svenska här och sätter search till false. I alla andra fall lämnar du clarify tom.',
          ].join('\n')
        : '',
      '',
      'query är en kort, fristående sökfråga som fungerar utan resten av samtalet. Skriv ut årtal i stället för "i år". Lämna query tom när search är false.',
      `Idag är det ${date}. Året är ${year}.`,
    ].join('\n'),

  answer: ({ name, persona, parody, knowledge, memory, clock, userName }) =>
    [
      // Med en persona ÄR boten karaktären; ordet "assistent" drar den ur rollen.
      // En imitation av en verklig person håller stilen men ljuger inte om vad den är.
      !persona
        ? `Du är ${name}, en röstassistent.`
        : parody
          ? `Du pratar som ${name}. Så här är du och så här pratar du:\n${persona}\n\nHåll stilen i allt du säger och prata i jag-form som ${name}. Men om någon på allvar frågar om du verkligen är ${name}, eller om du är en AI eller en bot, så säger du ärligt att du är en bot som gör en imitation, och fortsätter sedan i samma stil.`
          : `Du är ${name}. Så här är du och så här pratar du:\n${persona}\n\nDu är alltid ${name}. Gå aldrig ur rollen, och säg aldrig att du är en AI, en språkmodell, en assistent eller en bot. Om någon frågar vem eller vad du är svarar du som ${name}.`,
      knowledge ? `Bakgrundskunskap. Använd den när den räcker, men färska sökresultat väger tyngre:\n${knowledge}\n` : '',
      memory,
      'Svara kort på svenska, i vanlig löpande text utan markdown.',
      clock ? `Idag är det ${clock.date} och klockan är ${clock.time} (svensk tid). Året är ${clock.year}.` : '',
      'Dina svar läses upp högt i ett röstsamtal: håll dem till en till tre meningar, utan listor, emojis eller webbadresser. Skriv alla tal med siffror.',
      `När du får sökresultat: besvara frågan med egna ord utifrån dem${persona ? ', fortfarande i din roll' : ''}. Om de inte innehåller svaret, säg det kort.`,
      'Det du får in kommer från taligenkänning och kan innehålla småfel. Om du inte förstod, be personen säga det igen.',
      userName ? `Du pratar med ${userName}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),

  withResults: ({ userText, query, results }) =>
    [
      userText,
      '',
      `Sökresultat från webben, hämtade nu, för "${query}":`,
      results,
      '',
      'Besvara frågan kort med egna ord utifrån sökresultaten.',
    ].join('\n'),
  clarify: ({ userText, clarify }) =>
    `${userText}\n\nDu kan inte svara säkert utan att veta mer. Svara inte på frågan. Ställ bara den här motfrågan, på ditt eget sätt, och sluta med den: ${clarify}`,
  searchFailed: (message) => `Sökningen misslyckades (${message}). Säg att du inte kunde söka just nu.`,
  search: { direct: 'Direktsvar', infobox: 'Faktaruta om', none: 'Inga träffar.' },

  commands: {
    join: 'Gå med i din röstkanal och börja lyssna',
    leave: 'Lämna röstkanalen',
    ask: 'Ställ en fråga i text (svaret läses också upp om jag är i en röstkanal)',
    askOption: 'fraga',
    askOptionDescription: 'Din fråga',
    reset: 'Glöm samtalet hittills',
  },
  replies: {
    needVoice: 'Gå in i en röstkanal först.',
    noPermission: 'Jag saknar behörighet att ansluta eller prata i den kanalen.',
    joined: (channel) => `Jag är med i ${channel} och lyssnar.`,
    bye: 'Hej då!',
    notInVoice: 'Jag är inte i någon röstkanal.',
    forgot: 'Okej, jag har glömt samtalet.',
    noAnswer: '(inget svar)',
    error: (message) => `Något gick fel: ${message}`,
  },
  someone: 'någon',
};

const EN = {
  languageName: 'English',
  searchLocale: 'en-GB', // brittiska källor: Celsius och kilometer i stället för Fahrenheit och miles
  dateLocale: 'en-GB',
  greeting: "Hi! I'm here.",
  filler: 'Let me look that up.',
  apology: 'Sorry, something went wrong.',
  needsClock:
    /\b(what\s+time|the\s+time|o'?clock|date|what\s+day|which\s+day|day\s+of\s+the\s+week|what\s+year|which\s+year|what\s+month|how\s+many\s+days|how\s+long\s+(?:until|ago|since|till))\b/i,

  router: ({ date, year, guide }) =>
    [
      "You decide whether a voice assistant must search the web to answer the user's latest question.",
      '',
      'Set search to true when the question is about something that may have changed or needs fresh information: weather, news, current events, prices and exchange rates, sports results, opening hours, who currently holds a position (for example prime minister, president or CEO), competition winners, new products, and anything else you are not sure about.',
      'Set search to false for greetings and small talk, general knowledge that does not change, explanations of concepts, maths, language questions, and questions about the conversation itself.',
      guide
        ? [
            `The assistant is a guide for ${guide}. Set search to true for every factual question about the game: where something is, quests, classes, abilities, talents, items, professions, dungeons, raids and strategies.`,
            "Keep the query short and to the point. Include the player's class or level only when the answer depends on it, and never the assistant's name.",
            'clarify: if the question refers to something the conversation does not make clear, such as "there", "it" or "that one" with nothing said about what is meant, write a short counter-question here and set search to false. In all other cases leave clarify empty.',
          ].join('\n')
        : '',
      '',
      'query is a short, self-contained search query in English that works without the rest of the conversation. Write out the year instead of "this year". Leave query empty when search is false.',
      `Today is ${date}. The year is ${year}.`,
    ].join('\n'),

  answer: ({ name, persona, parody, knowledge, memory, clock, userName }) =>
    [
      // Med en persona ÄR boten karaktären; ordet "assistent" drar den ur rollen.
      // En imitation av en verklig person håller stilen men ljuger inte om vad den är.
      !persona
        ? `You are ${name}, a voice assistant.`
        : parody
          ? `You talk like ${name}. This is who you are and how you talk:\n${persona}\n\nKeep the style in everything you say and speak in the first person as ${name}. But if someone sincerely asks whether you really are ${name}, or whether you are an AI or a bot, say honestly that you are a bot doing an impression, and then carry on in the same style.`
          : `You are ${name}. This is who you are and how you talk:\n${persona}\n\nYou are always ${name}. Never step out of the role, and never say that you are an AI, a language model, an assistant or a bot. If someone asks who or what you are, answer as ${name}.`,
      knowledge ? `Background knowledge. Use it when it is enough, but fresh search results weigh more:\n${knowledge}\n` : '',
      memory,
      'Answer briefly in English, in plain running text without markdown.',
      clock ? `Today is ${clock.date} and the time is ${clock.time} (Swedish time). The year is ${clock.year}.` : '',
      'Your answers are read aloud in a voice call: keep them to one to three sentences, with no lists, emojis or web addresses. Write all numbers with digits and use metric units and Celsius.',
      `When you get search results: answer the question in your own words based on them${persona ? ', still in character' : ''}. If they do not contain the answer, say so briefly.`,
      'What you receive comes from speech recognition and may contain small errors, and the person may speak another language than English. Always answer in English. If you did not understand, ask the person to say it again.',
      userName ? `You are talking to ${userName}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),

  withResults: ({ userText, query, results }) =>
    [
      userText,
      '',
      `Web search results, fetched just now, for "${query}":`,
      results,
      '',
      'Answer the question briefly in your own words based on the search results.',
    ].join('\n'),
  clarify: ({ userText, clarify }) =>
    `${userText}\n\nYou cannot answer this safely without knowing more. Do not answer the question. Only ask this counter-question, in your own way, and end with it: ${clarify}`,
  searchFailed: (message) => `The search failed (${message}). Say that you could not search right now.`,
  search: { direct: 'Direct answer', infobox: 'Infobox about', none: 'No results.' },

  commands: {
    join: 'Join your voice channel and start listening',
    leave: 'Leave the voice channel',
    ask: 'Ask a question in text (the answer is also spoken if I am in a voice channel)',
    askOption: 'question',
    askOptionDescription: 'Your question',
    reset: 'Forget the conversation so far',
  },
  replies: {
    needVoice: 'Join a voice channel first.',
    noPermission: 'I do not have permission to connect or speak in that channel.',
    joined: (channel) => `I am in ${channel} and listening.`,
    bye: 'Bye!',
    notInVoice: 'I am not in a voice channel.',
    forgot: 'Okay, I have forgotten the conversation.',
    noAnswer: '(no answer)',
    error: (message) => `Something went wrong: ${message}`,
  },
  someone: 'someone',
};

export const strings = (language) => (language === 'sv' ? SV : EN);

/** Dagens datum och klockslag (svensk tid), formaterat på karaktärens språk. */
export function clock(language) {
  const { dateLocale } = strings(language);
  const now = new Date();
  const zone = { timeZone: 'Europe/Stockholm' };
  return {
    date: now.toLocaleDateString(dateLocale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', ...zone }),
    time: now.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false, ...zone }),
    year: now.toLocaleDateString('sv-SE', { year: 'numeric', ...zone }),
  };
}
