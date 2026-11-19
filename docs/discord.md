# Skapa en Discord-bot till en karaktär

Varje karaktär som ska in på Discord behöver en egen bot med en egen token. Det tar ett par
minuter och kostar ingenting. Karaktärer som bara finns lokalt behöver inget av det här.

## 1. Skapa appen

1. Gå till <https://discord.com/developers/applications> och logga in.
2. Klicka på **New Application**, ge den karaktärens namn och skapa den.
3. Under **General Information** kan du lägga in en bild. Den blir botens profilbild.

## 2. Gör boten privat

Annars kan vem som helst som hittar länken lägga till din bot på sin server.

1. **Installation** → **Install Link**: välj **None**.
2. **Bot** → stäng av **Public Bot**.

Görs stegen i fel ordning klagar Discord på att en privat app inte kan ha en
installationslänk. Sätt då länken till **None** först och spara.

Inga *Privileged Gateway Intents* behöver slås på.

## 3. Hämta token

1. **Bot** → **Reset Token** → **Copy**.

Token visas bara en gång. Den är botens lösenord, så klistra inte in den i chattar eller
skärmdumpar. Skulle den läcka: klicka på **Reset Token** igen, då slutar den gamla att fungera.

## 4. Lägg in token i ShatterBox

Välj ett av sätten:

- **Terminalen:** `shatterbox new` och välj Discord (eller `shatterbox edit <namn>` för en
  karaktär som redan finns). Token syns inte medan du klistrar in den.
- **Kontrollpanelen:** `shatterbox ui` → **Ny karaktär** eller **Redigera** → fältet Discord-token.

Token kontrolleras mot Discord direkt, och du får veta vilket konto den hör till. Den sparas
i filen `.env` på din dator och ingen annanstans.

## 5. Starta och bjud in

1. `shatterbox start` (eller `shatterbox restart` om allt redan är igång).
2. `shatterbox bots --invite` visar en inbjudningslänk för karaktären, och kontrollpanelen
   har knappen **Bjud in till server**. Öppna länken, välj din server och godkänn.
3. Gå in i en röstkanal och skriv `/join` i en textkanal på servern.

Boten behöver rättigheterna *Anslut* och *Tala* i röstkanalen. Länken ber om dem.

## 6. Valfritt: låt botarna följa med dig

1. Discord → **Inställningar** → **Avancerat** → slå på **Utvecklarläge**.
2. Högerklicka på dig själv → **Kopiera användar-ID**.
3. Lägg in det i `.env` som `DISCORD_OWNER_ID=<ditt id>`, och starta om med `shatterbox restart`.

Då går botarna med så fort du går in i en röstkanal. Vill du välja själv vilken karaktär som
är med för stunden: sätt `AUTO_JOIN=false` och använd `/join`.

## Vanliga fel

| Fel | Orsak |
| --- | --- |
| "Discord godkände inte den token" | fel sträng kopierad. Hämta en ny med **Reset Token** |
| "Den token används redan av …" | varje karaktär behöver en egen app och bot |
| Boten är inloggad men syns inte på servern | den är inte inbjuden. Använd inbjudningslänken |
| `/join` finns inte | kommandona registreras när boten bjuds in. Vänta en minut eller starta om Discord |
| Boten går med men säger inget | talsyntesen är inte igång. Se `shatterbox status` |
