---
title: Übersicht, Status und Logs
summary: Nutzungszahlen, der Auftritt des Bots und was schiefging.
---
## Übersicht

Die **Übersicht** eines Bots zeigt Kacheln mit den Summen und je Zahl ein kleines Diagramm:

- **Neue Mitglieder** (Beitritte und Austritte), **Aktive Nutzer** (wer geschrieben, einen Command genutzt oder im Voice war), **Nachrichten**, **Voice-Minuten**, **Moderation** (Commands und AutoMod), **Commands**, **Plugin-Nutzungen**.
- Fahr mit der Maus über einen Punkt, um Wert und Zeit zu sehen.
- Filter nach **Server** und **Zeitraum** (24 Stunden, 7 Tage, 30 Tage oder ein eigener Zeitraum).
- Darunter: die meistgenutzten Commands, Plugins und Moderations-Aktionen.

Die Zahlen werden 35 Tage aufbewahrt.

## Status

Unter **Status** legst du fest, wie der Bot in Discord erscheint:

- **Online-Status** (online, abwesend, nicht stören, unsichtbar).
- **Aktivität** wie *Spielt …* oder *Schaut …*, oder ein **eigener Status** mit Emoji.
- **Rotation**: mehrere Einträge, die im Intervall wechseln. Variablen wie `{servers}` werden eingesetzt.
- **Profil**: Bio und Pronomen des Bots.

## Logs

**Logs** listet, was passiert ist: Starts, Fehler von Commands und Events, fehlende Rechte, Probleme von Plugins. Jeder Eintrag hat einen Code (z. B. `WAR-2002`) und einen lesbaren Text. Mit dem Filter zeigst du nur Warnungen und Fehler.

> [!TIP]
> Ein Command tut nichts? Schau zuerst in die Logs: meist fehlt dem Bot ein Recht oder eine Einstellung.
