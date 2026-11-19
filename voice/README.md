# Röstprov

Här hamnar röstproven som karaktärerna klonar sin röst från. Mappens innehåll är undantaget
från git, eftersom en röst är personlig.

## Lägga in ett röstprov

- Kontrollpanelen: **Redigera** → **Röstprov**.
- Terminalen: `shatterbox voice <karaktär> <ljudfil>`.

Filen sparas som `voice/<karaktärens namn>.<ändelse>`, till exempel `voice/kapten-krok.wav`.
Den första karaktärens prov heter `voice/reference.*`. Format: wav, m4a, mp3, flac, ogg med flera.
Rösten byts vid nästa mening, utan omstart.

## Spela in

Läs i ett svep, i vanlig samtalston, med samma mikrofon som du brukar använda:

> Hej, det är jag som pratar. Jag sitter hemma vid datorn en vanlig kväll och tänkte köra
> några timmar. Skjut gärna in en fråga om du undrar något, så kollar jag upp det på en gång.

- **Tempot kopieras.** Pratar du långsamt eller pausar mycket blir karaktärens tal utdraget.
- **Tonen kopieras också.** Läs som du vill att karaktären ska låta.
- **Tyst bakgrund.** Ingen musik, inget spelljud, inget eko.
- **10–15 sekunder räcker.** Utan avskrift används bara de första tio sekunderna.

## Längre prov med avskrift

Vill du att hela en längre inspelning ska användas lägger du en textfil bredvid ljudfilen,
med samma namn men ändelsen `.txt` och exakt det som sägs, ord för ord:

```
voice/kapten-krok.wav
voice/kapten-krok.txt
```

Lägg dit textfilen efter att du laddat upp ljudet. En gammal avskrift tas bort när ett nytt
prov laddas upp. Ett längre prov gör att varje mening tar längre tid att skapa, så börja med
runt 30 sekunder.

## Tänk på

Klona bara röster du har rätt att använda. Låt inte en klonad röst utge sig för att vara
personen på riktigt, och sprid inte klipp som kan tas för äkta.
