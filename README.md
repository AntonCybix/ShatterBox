# ShatterBox

Lokala röstkaraktärer som lyssnar, tänker, söker på nätet och svarar med en klonad röst.
Allt körs på din egen dator. Varje karaktär kan antingen vara en **Discord-bot** som går med
i röstkanaler, eller finnas **bara lokalt** så att du pratar med den i terminalen.

```
du pratar (Discord eller terminalen)
   ├─> tal-till-text   KB-Whisper på processorn           (Docker)
   ├─> språkmodell     gemma4:e2b via Ollama              (direkt på datorn, grafikkortet)
   ├─> webbsök         SearXNG, när frågan kräver det     (Docker)
   └─> talsyntes       OmniVoice med klonad röst          (direkt på datorn, grafikkortet)
   <── svaret spelas upp där du pratade
```

## Innehåll

- [Installera](#installera)
- [Kom igång på fem minuter](#kom-igång-på-fem-minuter)
- [Prata i terminalen](#prata-i-terminalen)
- [Karaktärer](#karaktärer)
- [Kommandon](#kommandon)
- [Kontrollpanelen](#kontrollpanelen)
- [Discord](#discord)
- [Röster](#röster)
- [Inställningar](#inställningar)
- [Var saker ligger](#var-saker-ligger)
- [Felsökning](#felsökning)
- [Vad som är testat](#vad-som-är-testat)
- [Licens](#licens)

## Installera

### Det här behövs

| | Windows | Linux |
| --- | --- | --- |
| Node.js 18 eller nyare | installeras av `setup.cmd` om det saknas | `sudo apt install nodejs` |
| Docker | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | [Docker Engine](https://docs.docker.com/engine/install/) med Compose-tillägget |
| Ollama | [ollama.com](https://ollama.com/download) | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Grafikkort | AMD Radeon RX 7000/9000 eller NVIDIA | NVIDIA eller AMD |
| Ljud i terminalen | inget extra | `sudo apt install alsa-utils` |

Utan grafikkort fungerar det också, men talet tar längre tid att skapa. Räkna med ungefär
25 GB disk för modeller, Python-miljö och Docker-avbilder (uppmätt med AMD-varianten).

### Windows

```
git clone https://github.com/AntonCybix/ShatterBox.git
cd ShatterBox
setup.cmd
```

### Linux

```
git clone https://github.com/AntonCybix/ShatterBox.git
cd ShatterBox
./setup.sh
```

### Vad installationsguiden gör

Guiden går igenom sju steg, frågar innan den laddar ner något stort och hoppar över det som
redan finns. Den går bra att köra flera gånger.

1. Kontrollerar att Node.js, Docker och Ollama finns, och säger hur du installerar det som saknas.
2. Skapar `.env` från `.env.example`.
3. Hämtar språkmodellen (`ollama pull gemma4:e2b`, några GB).
4. Installerar talsyntesen i en egen Python-miljö under projektmappen. Guiden känner av
   grafikkortet och väljer rätt PyTorch: AMD (ROCm), NVIDIA (CUDA) eller bara processorn.
5. Bygger Docker-avbilderna för tal-till-text, webbsök och Discord-botarna.
6. Hjälper dig skapa din första karaktär: namn, språk, Discord eller lokal, persona och röst.
7. Windows: skapar genvägen **ShatterBox** på skrivbordet, som öppnar kontrollpanelen.

Kontrollera läget när som helst med `shatterbox doctor`. Den visar vad som finns, vad som
saknas och exakt vilket kommando som åtgärdar det.

> I Linux skrivs kommandot `./shatterbox` och i Windows `shatterbox`. Resten av texten
> skriver `shatterbox`.

## Kom igång på fem minuter

```
shatterbox start          startar allt (första gången laddas talmodellerna ner)
shatterbox talk           pratar med en karaktär i terminalen
shatterbox new            skapar en karaktär till
shatterbox ui             öppnar kontrollpanelen i webbläsaren
```

Kör du `shatterbox` utan något efter får du en meny med samma val.

## Prata i terminalen

```
shatterbox talk eko
```

Det öppnar ett samtalsfönster i terminalen. Överst rör sig ljudstaplar i takt med rösten,
med olika färg och rörelse för när karaktären lyssnar, tänker, söker och pratar. Under
staplarna står samtalet, och längst ner skriver du.

| Tangent | Vad den gör |
| --- | --- |
| Enter | skickar det du skrivit |
| Tab | slår av och på mikrofonen |
| Esc | avbryter svaret (staplarna spricker i skärvor) |
| Ctrl+C | avslutar |

| Kommando i fönstret | Vad det gör |
| --- | --- |
| `/mics` | visar mikrofonerna (Windows) |
| `/mic 2` | byter till mikrofon nummer 2. Valet sparas |
| `/reset` | karaktären glömmer samtalet |
| `/quit` | avslutar |

Med mikrofonen på pratar du som vanligt, och karaktären svarar när du varit tyst en knapp
sekund. Mikrofonen stängs medan karaktären pratar, eftersom den annars hör sig själv i
högtalarna. Har du hörlurar kan du starta med `--barge`, och då kan du avbryta genom att prata.

| Val | Betydelse |
| --- | --- |
| `--mic` | börja med mikrofonen på |
| `--mic=<nr eller namn>` | välj mikrofon. I Linux ett ALSA-namn, t.ex. `--mic=plughw:1,0` |
| `--list-mics` | visa mikrofonerna |
| `--barge` | lyssna även medan karaktären pratar (använd hörlurar) |
| `--mute` | inget ljud, bara text |
| `--plain` | enkel textdialog utan helskärm. Väljs automatiskt utan terminal, t.ex. via en pipe |
| `--ascii` | bara ASCII-tecken i staplarna, för terminaler utan blocktecken |
| `--user=<namn>` | vem som pratar, för karaktärer med minne |
| `--no-greeting` | hoppa över hälsningsfrasen |

En enda fråga går också bra, till exempel från ett skript:

```
shatterbox talk eko "Vad blir det för väder i Luleå i morgon?"
```

`talk` fungerar för alla karaktärer, även de som är Discord-botar. En maskin utan skärm och
ljudkort kan köra allt över SSH: staplarna ritas i terminalen, och med `--mute` behövs inget ljud.

## Karaktärer

En karaktär består av ett namn, ett språk, en persona och en röst. När du skapar eller
ändrar en karaktär väljer du var den ska finnas:

- **Discord**: en egen Discord-bot med egen token. Den går med i röstkanaler och pratar där.
- **Bara på den här datorn**: ingen Discord behövs. Du pratar med den via `shatterbox talk`
  eller knappen **Prata** i kontrollpanelen.

Valet går att ändra när som helst, i kontrollpanelen eller med `shatterbox edit <namn>`.

```
shatterbox new                                   guide som frågar igenom allt
shatterbox new --name=Eko --local --yes          utan frågor
shatterbox edit eko                              ändra
shatterbox voice eko ~/inspelning.wav            byt röstprov
shatterbox remove eko
```

Alla karaktärer delar på samma modeller, så fler karaktärer kostar inget extra när de är
tysta. Det går att ha upp till nio.

### Persona

Personan är en textfil, `personas/<namn>.txt`, som beskriver vem karaktären är och hur den
pratar. Filen läses om vid nästa fråga, så du kan finslipa utan omstart. Inga färdiga
karaktärer följer med, du skapar dina egna. Tips för att skriva en persona finns i
[personas/README.md](personas/README.md).

**Imitation av en verklig person:** kryssa i *Imitation* (eller `--parody`). Karaktären
håller då stilen men säger ärligt att den är en bot om någon frågar på allvar. Utan den
inställningen stannar karaktären alltid i rollen, vilket passar påhittade figurer.

### Extra förmågor

Några förmågor går att ge vilken karaktär som helst genom rader i `.env` (`BOT3_` är
karaktärens nummer). Tillsammans blir de till exempel en spelguide som sitter med i röstkanalen:

| Förmåga | Inställning | Fil |
| --- | --- | --- |
| Svarar bara när någon säger namnet. Gäller i Discord | `BOT3_WAKE_ONLY=true`, fler ord med `BOT3_WAKE_WORDS=` | |
| Förstår flera språk | `BOT3_LISTEN_LANGUAGES=sv,en` | |
| Söker på ett annat språk och alltid inom sitt ämne | `BOT3_SEARCH_LANGUAGE=en`, `BOT3_SEARCH_HINT=<ämnet>` | |
| Har bakgrundskunskap från start | | `knowledge/<namn>.md` |
| Rättar ord som taligenkänningen hör fel | | `knowledge/<namn>.terms.txt` |
| Minns varje spelares spelkaraktär: ras, klass, level och yrken. Byggd för World of Warcraft | `BOT3_MEMORY=true` | `data/memory/<namn>.json` |
| Egen, större språkmodell | `BOT3_MODEL=gemma4:e4b` | |

## Kommandon

| Kommando | Vad det gör |
| --- | --- |
| `setup` | installationsguiden |
| `doctor` | visar vad som finns, saknas och är igång |
| `start` / `stop` | startar eller stoppar allt |
| `restart` | startar om Discord-botarna. Behövs efter ändrat namn, språk, läge eller token |
| `status` | läget för tjänsterna och varje karaktär |
| `logs [bot\|tts]` | visar loggen. `--follow` följer botarnas logg |
| `talk [karaktär] ["fråga"]` | samtal i terminalen |
| `bots` | listar karaktärerna. `--invite` visar inbjudningslänkarna till Discord |
| `new`, `edit <karaktär>`, `remove <karaktär>` | skapar, ändrar och tar bort |
| `voice <karaktär> <ljudfil>` | byter röstprov. `--remove` tar bort det |
| `ui` | öppnar kontrollpanelen |
| `help` | alla kommandon och val |

En karaktär anges med namn, början av namnet eller nummer: `shatterbox talk ek`.

## Kontrollpanelen

`shatterbox ui`, eller genvägen **ShatterBox** på skrivbordet i Windows, öppnar en lokal
webbsida på `http://127.0.0.1:8090`.

- **Starta allt / Stoppa allt** och läget för varje del.
- **Ny karaktär** och **Redigera**: samma val som i terminalen, inklusive Discord eller lokal,
  persona, röstprov och designad röst.
- **Prata** öppnar ett terminalfönster med `shatterbox talk` för karaktären.
- **Bjud in till server** visas för Discord-karaktärer med token.
- **Logg** visar vad botarna hör och svarar.

Panelen går bara att nå från den egna datorn. Tokens sparas i `.env` och visas aldrig igen.
På en maskin utan skärm når du panelen genom en SSH-tunnel:
`ssh -L 8090:127.0.0.1:8090 användare@maskinen`.

## Discord

En steg-för-steg-guide med allt som ska klickas i Discords utvecklarportal finns i
[docs/discord.md](docs/discord.md). I korthet:

1. Skapa en app på <https://discord.com/developers/applications> och hämta botens token.
2. Lägg in token med `shatterbox new` (välj Discord) eller i kontrollpanelen. Den
   kontrolleras mot Discord direkt.
3. `shatterbox start`, och bjud sedan in boten med länken från `shatterbox bots --invite`.

I Discord styrs boten med fyra kommandon:

| Kommando | Vad det gör |
| --- | --- |
| `/join` | boten går med i röstkanalen du sitter i och börjar lyssna |
| `/leave` | boten lämnar röstkanalen |
| `/ask` | ställ en fråga i text. Svaret läses också upp om boten är i en röstkanal |
| `/reset` | boten glömmer samtalet hittills |

Prata som vanligt. Boten svarar när du varit tyst en knapp sekund, och tystnar när någon
säger minst två ord (eller "tyst", "stopp"). När alla människor lämnat kanalen går boten också.

Sitter två karaktärer med olika språk i samma kanal svarar den vars språk du pratar. Säger
du en karaktärs namn svarar just den.

## Röster

Rösten väljs i den här ordningen:

1. **Röstprov**: en ljudfil med 10–15 sekunder tal, som klonas. Ladda upp den i
   kontrollpanelen eller med `shatterbox voice <karaktär> <fil>`. Den hamnar i `voice/`.
2. **Designad röst**: en beskrivning i ord, till exempel `male, elderly, low pitch`.
3. **Standardrösten** för språket.

Röstprov gäller från nästa mening, utan omstart. Ett manus att läs in och råd om inspelning
finns i [voice/README.md](voice/README.md).

Klona bara röster du har rätt att använda, och låt inte en klonad röst utge sig för att
vara personen på riktigt.

## Inställningar

Allt ligger i `.env`. Det vanligaste ställs in via kontrollpanelen eller `shatterbox edit`,
och hela listan med förklaringar står i [.env.example](.env.example).

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `OLLAMA_MODEL` | `gemma4:e2b` | språkmodell. `gemma4:e4b` svarar märkbart bättre men tar mer grafikminne |
| `STT_MODEL` | `KBLab/kb-whisper-small` | större (`-medium`, `-large`) hör bättre men är långsammare |
| `TTS_STEPS` | `16` | 32 ger något bättre ljud men dubbla väntetiden |
| `TTS_DEVICE` | – | `cpu` tvingar talsyntesen till processorn |
| `SILENCE_MS` | `900` | hur lång tystnad som räknas som att du pratat klart |
| `BARGE_IN_WORDS` | `2` | hur många ord som krävs för att avbryta en bot som pratar |
| `DISCORD_OWNER_ID` | – | ditt användar-ID. Botarna följer då med dig in i röstkanaler |
| `TALK_USER` | datorns användarnamn | vad karaktärerna kallar dig i terminalen |

Ändringar i `.env` gäller efter `shatterbox stop` och `shatterbox start`.

## Var saker ligger

| Mapp eller fil | Innehåll |
| --- | --- |
| `cli/` | kommandot `shatterbox`, installationsguiden och samtalsfönstret (`cli/talk/`) |
| `app/` | kontrollpanelen |
| `lib/` | det som kommandot och panelen delar på: karaktärer, `.env`, tjänsterna |
| `services/bot/` | samtalslogiken och Discord-botarna (Node.js) |
| `services/stt/` | tal-till-text (faster-whisper) |
| `services/tts-gpu/` | talsyntesen OmniVoice |
| `services/tts/` | reservläge: Chatterbox på processorn i Docker |
| `scripts/` | start, stopp och installation: `.ps1` för Windows och `.sh` för Linux |
| `personas/`, `knowledge/`, `voice/` | karaktärernas personor, kunskap och röstprov |
| `data/` | minne och sparade val. Skapas vid behov |
| `models/`, `tools/`, `.venv-omnivoice/` | nedladdade modeller och Python-miljön. Skapas av setup |

`.env`, `voice/`, `data/`, egna personor och allt nedladdat är undantaget från git, så en
`git pull` rör inte dina karaktärer.

### Varför inte allt i Docker?

Docker Desktop på Windows kommer inte åt AMD-grafikkort. Därför körs Ollama och talsyntesen
direkt på datorn, och resten i Docker. I Linux fungerar samma uppdelning. Där delar
Discord-botarnas container värdens nätverk (`docker-compose.linux.yml`) för att nå dem.

## Felsökning

Börja alltid med `shatterbox doctor` och `shatterbox status`.

- **Karaktären svarar bara i text.** Talsyntesen är inte igång. Se `shatterbox logs tts`.
  Är Python-miljön trasig installerar `shatterbox setup` om den.
- **Mikrofonen ger inget ljud.** Fel enhet är vald. Skriv `/mics` i samtalsfönstret och byt
  med `/mic <nummer>`. I Linux: `arecord -L` och sedan `--mic=<enhet>`.
- **Inget ljud i Linux.** Installera `alsa-utils` och prova `aplay /usr/share/sounds/alsa/Front_Center.wav`.
- **Staplarna är fyrkanter eller frågetecken.** Terminalen saknar blocktecknen. Starta med `--ascii`.
- **"Språkmodellen (Ollama) är inte igång".** `shatterbox start`, eller starta Ollama för hand.
- **Webbsöket svarar inte.** Starta med `shatterbox start` och inte med `docker compose up`
  direkt. Startskriptet skapar `searxng/settings.yml` från mallen första gången.
- **Boten svarar inte i Discord.** `shatterbox logs` visar vad den hörde, om den sökte och
  hur lång tid talet tog.
- **Boten kopplas ner direkt från röstkanalen (kod 4017).** Discord kräver krypteringen DAVE.
  Den följer med i koden. Bygg om med `docker compose build --no-cache bot`.
- **Boten tystnar för lätt.** Höj `BARGE_IN_WORDS`, eller sätt `BARGE_IN=false`.
- **Svaren är dumma.** `gemma4:e2b` är en mycket liten modell. Byt till `gemma4:e4b`
  (`ollama pull gemma4:e4b`, sedan `OLLAMA_MODEL=gemma4:e4b`).
- **Rösten låter inte som originalet.** Prova ett renare röstprov utan musik och eko, och `TTS_STEPS=32`.
- **En designad röst blir aldrig klar.** Vissa ordkombinationer ger bara brus. Talsyntesen
  provar sex gånger och faller sedan tillbaka på standardrösten. Prova färre ord.
- **Karaktären håller inte stilen.** Gör personan mer konkret, och prova en större modell.

## Vad som är testat

Projektet är utvecklat och använt på en maskin: Windows 11 med AMD Radeon RX 9070 XT.

| Del | Läge |
| --- | --- |
| Windows + AMD: installation av talsyntes, start, stopp | testat |
| Discord: lyssna, söka, svara, avbryta, flera karaktärer inloggade | testat |
| Två karaktärer i samma röstkanal | inte testat i Discord, bara från kommandoraden |
| Kontrollpanelen: skapa, ändra, växla Discord/lokal, Prata-knappen | testat |
| `shatterbox talk` i Windows: samtalsfönster, tangenter, uppspelning | testat |
| Mikrofon i Windows: inspelning från enheten, och hela kedjan med inmatat tal | testat var för sig, inte med en människa som pratar |
| Kommandot och installationsguiden i Linux | testat i en container, utan ljud och grafikkort |
| Riktig installation på en Linux-maskin, ljud via ALSA, Discord-botar i Linux | **inte testat** |
| NVIDIA (CUDA) och talsyntes på bara processorn | **inte testat** |
| macOS | stöds inte |

Stöter du på fel i de otestade delarna hjälper `shatterbox doctor` och loggarna dig en bit.

## Licens

Koden i det här repot är fri att använda, ändra och dela enligt [MIT-licensen](LICENSE).

Modellerna ingår inte i repot. De laddas ner vid installationen och har egna licenser:
Gemma (Google), KB-Whisper (KBLab), Whisper (OpenAI) och OmniVoice (k2-fsa). Läs dem innan
du använder projektet till något annat än privat bruk.
