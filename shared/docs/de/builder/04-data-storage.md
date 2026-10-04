---
title: Data Storage
summary: Eigene Variablen für Zähler, Listen und Einstellungen.
---
**Data Storage** (Module → Utility) hält deine eigenen Variablen.

## Eine Variable

- **Key**: `a-z`, `0-9` und `_`, genutzt als `{var.<key>}`.
- **Typ**: Text, Zahl, Liste, Objekt oder Liste von Objekten.
- **Besitzer**: ein Wert für alles, **einer pro Mitglied** oder **einer pro Channel**.
- **Pro Server**: getrennte Werte pro Server (Standard) oder einer für alle.
- **Standardwert**.

## Benutzen

In den Buildern gibt es Blöcke zum **Setzen**, **Ändern** (addieren, abziehen, an eine Liste hängen), **Lesen** und **Zurücksetzen** von Variablen. Die Data-Storage-Seite zeigt die gespeicherten Werte und lässt dich sie von Hand ändern.

Auch Plugins können eigene Variablen anlegen (zum Beispiel das Work-Plugin). Sie erscheinen in einer eigenen Gruppe.

> [!NOTE]
> Mit dem Event *Variable geändert* reagierst du auf Änderungen, z. B. eine Rolle geben, wenn ein Zähler 100 erreicht.
