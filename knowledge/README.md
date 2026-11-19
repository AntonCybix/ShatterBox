# Kunskap och ordlistor

Här kan en karaktär få bakgrundskunskap och en ordlista. Filerna heter som karaktären, med
små bokstäver och bindestreck. Innehållet i mappen är undantaget från git.

| Fil | Vad den gör |
| --- | --- |
| `<namn>.md` | Fakta som alltid skickas med till språkmodellen. Håll den kort: allt här kostar tid i varje svar |
| `<namn>.terms.txt` | Ord som taligenkänningen ofta hör fel, ett per rad |

Båda läses om när de ändras, utan omstart.

## Ordlistan

Ett ord per rad. Felhörningar som ska rättas till ordet skrivs efter ett likhetstecken:

```
Stormwind
Ironforge = iron forge, ajron fordj
levla = leva, levela
```

Ord som bara står för sig själva rättas när taligenkänningen skriver något som låter
nästan likadant. Lägg in namn på platser, föremål och personer som karaktären ska känna igen.
