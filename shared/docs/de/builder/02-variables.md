---
title: Variablen und Platzhalter
summary: Platzhalter wie {user.name}, Optionswerte, Ergebnisse von Blöcken und eigene Daten.
---
Texte in Blöcken und Nachrichten dürfen **Platzhalter** in geschweiften Klammern enthalten. Die Variablen-Auswahl (der `{}`-Button neben einem Feld) listet jeden Platzhalter, der dort passt.

## Immer da

| Platzhalter | Wert |
|---|---|
| `{user.id}`, `{user.name}`, `{user.mention}` | Das Mitglied, das den Command genutzt oder das Event ausgelöst hat |
| `{server.id}`, `{server.name}`, `{server.members}` | Der Server |
| `{channel.id}`, `{channel.name}`, `{channel.mention}` | Der Channel |
| `{command.name}` | Der Command |

## Optionen

Jede Option eines Commands ist `{option_<name>}`, zum Beispiel `{option_grund}`. Eine weggelassene Option ist leerer Text.

## Ergebnisse von Blöcken

Viele Blöcke liefern Ergebnisse. Ein Block mit dem Variablennamen `px` liefert `{px}` und oft mehr, etwa `{px.balance}` oder `{px.count}`. Die Info des Blocks im Builder listet seine Ergebnisse.

## Eigene Daten

Variablen aus **Data Storage** schreibt man `{var.<key>}`. Sie halten einen Wert, einen pro Mitglied oder einen pro Channel, getrennt pro Server. Siehe [Data Storage](/docs/builder/data-storage).
