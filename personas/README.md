# Personor

En persona är en textfil som beskriver vem en karaktär är och hur den pratar. Filen heter
som karaktären, med små bokstäver och bindestreck: karaktären "Kapten Krok" läser
`personas/kapten-krok.txt`. Filen läses om vid nästa fråga, så du kan ändra och prova direkt.

Inga färdiga personor följer med. De du skriver själv är undantagna från git.

## Så skriver du en som fungerar

Språkmodellen är liten, så tydlighet slår längd.

- **Skriv på karaktärens språk** och tilltala den med "du": "Du är Kapten Krok, …".
- **Beskriv hur den pratar, inte bara vem den är.** Typiska ord, hur den tilltalar folk,
  meningslängd, humor. "Korta, raka meningar. Kallar alla för matros."
- **Ge korta regler i punktform.** En regel per rad följs bättre än ett långt stycke.
- **Säg hur långt svaret får vara.** "Håll det kort: en till tre meningar."
- **Skriv in fakta som karaktären ska kunna om sig själv,** och lägg till: "Hitta aldrig på
  något om dig själv utöver det som står här." Annars fyller modellen i luckorna.
- **Var försiktig med exempel.** Modellen härmar dem gärna ordagrant. Använd exempel som
  visar stilen ("Vanligt: Det regnar. Du: …"), aldrig exempel som innehåller faktasvar.
- **Säg vad den ska göra när den inte vet.** "Om du inte vet: säg det rakt ut."

## Verkliga personer

Kryssa i *Imitation* för en karaktär som härmar en verklig person. Då håller den stilen men
säger ärligt att den är en bot om någon frågar på allvar. Lägg inte påhittade uttalanden
eller privatliv i munnen på verkliga människor.

## Mer än en persona

- `knowledge/<namn>.md`: bakgrundskunskap som alltid skickas med. Håll den kort.
- `knowledge/<namn>.terms.txt`: ord som taligenkänningen ofta hör fel, ett per rad, med
  felhörningar efter likhetstecken: `Stormwind = storm vind, stormvinn`.
