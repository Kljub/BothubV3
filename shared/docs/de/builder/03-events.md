---
title: Custom und Timed Events
summary: Blöcke ausführen, wenn auf Discord etwas passiert, oder nach Zeitplan.
---
## Custom Events

**Custom Events** (Module → Utility) funktionieren wie Commands, starten aber bei etwas, das auf Discord passiert:

- ein Mitglied tritt bei oder verlässt den Server, bekommt oder verliert eine Rolle,
- eine Nachricht wird gesendet, bearbeitet, gelöscht oder bekommt eine Reaktion,
- jemand betritt einen Voice-Channel,
- ein Button oder Auswahlmenü des Bots wird benutzt,
- eine Data-Storage-Variable ändert sich, und mehr.

Der Auslöser-Block des Events liefert die passenden Platzhalter, z. B. `{message.content}` oder `{member.id}`.

## Timed Events

**Timed Events** (Module → Utility) sind Zeitpläne: ein **Intervall** (mindestens 10 Sekunden) oder **Uhrzeiten** (bis zu 24, z. B. `08:00, 20:30`) an gewählten **Wochentagen**. Ein Timed Event startet jedes Custom Event vom Typ *Wenn ein Timed Event läuft*, das es ausgewählt hat; dort gibt es `{schedule.name}` und `{schedule.next}`.

Die Zeiteinstellungen der Seite enthalten die **Zeitzone** (auch Module wie die Economy-Lotterie nutzen sie) und einen **Standard-Server**: Timed Events laufen dort, und `{DEFAULT_SERVER}` kann in jedem Server-ID-Feld stehen.

> [!TIP]
> Ein Timed Event hat von sich aus kein Mitglied und keinen Channel: wähl den Channel in den Blöcken, die etwas senden.
