---
title: Command Builder
summary: Eigene Slash-Commands aus Blöcken bauen, ohne Code.
---
Im **Command Builder** (Module → Utility) legst du eigene Commands an. Ein Command ist ein **Graph**: Blöcke, mit Linien verbunden, vom Auslöser bis zur Antwort.

## Einen Command anlegen

1. Öffne den **Command Builder** und klick auf **Neuer Command**.
2. Der **Auslöser**-Block enthält Name und Beschreibung (`/hallo`). **Optionen** (Text, Zahl, Benutzer, Channel, Rolle, Auswahl, Anhang) fügst du hinzu, indem du Options-Blöcke mit ihm verbindest.
3. Zieh Blöcke aus der Liste links auf die Fläche und verbinde sie: **Aktionen** (Nachricht senden, Rolle geben, …), **Bedingungen** (wenn/sonst), **Variablen** und die Blöcke der Module und Plugins.
4. **Speichern**. Schalte den Command in der Liste an; Discord zeigt ihn nach ein paar Sekunden.

## Einstellungen des Auslösers

- **Antworten verbergen**: nur der Benutzer sieht die Antworten.
- **Sichtbarkeits-Option**: der Name einer Auswahl-Option mit *Public* und *Only me*: das Mitglied wählt bei jeder Nutzung, wer die Antwort sieht.
- **Cooldown** pro Benutzer, Server oder für alle.
- **Rechte**: erlaubte und gesperrte Rollen, benötigte Rechte, gesperrte Channels.
- **Command-Typ**: Slash-Command oder ein Rechtsklick-Menü an einem Benutzer oder einer Nachricht.

## Gruppen und Versionen

Commands lassen sich in **Gruppen** sortieren. Jedes Speichern behält eine Version; eine ältere lässt sich wiederherstellen. Gelöschte Commands bleiben 30 Tage unter *Kürzlich gelöscht*.

## Fehler

Verbinde einen **Fehler-Handler**-Block, um etwas anzuzeigen, wenn ein Block scheitert, zum Beispiel `❌ {error}`. `{error}` enthält einen lesbaren Grund.

Weiter: [Variablen und Platzhalter](/docs/builder/variables).
