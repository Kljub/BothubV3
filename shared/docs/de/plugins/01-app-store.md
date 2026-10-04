---
title: Der App Store
summary: Plugins installieren, erlauben, was sie dürfen, pro Bot einschalten.
---
Plugins bringen Commands und Funktionen: Spiele, KI-Chat, Bildgenerierung, Plex, Server-Backups und mehr. Sie kommen aus dem **BotHub Marketplace**.

## Installieren

Öffne den **App Store** im Benutzermenü. Jedes Plugin zeigt Beschreibung, Version, Commands und die **SDK-Rechte**, die es braucht. Klick auf **Installieren**. Updates erscheinen dort auch.

## Erlauben, was es darf

Ein Plugin läuft in einer Sandbox und kann nur, was der Admin unter **Admin → SDK-Richtlinien** erlaubt: Nachrichten senden, Mitglieder lesen, Rollen verwalten, die Economy nutzen, Secrets nutzen und so weiter. Ein Plugin, dessen Rechte nicht erlaubt sind, zeigt *Deaktiviert* und die fehlenden Rechte.

## Pro Bot einschalten

Unter **Plugins** in der Seitenleiste schaltest du das Plugin für den Bot an. Seine Seite zeigt:

- seine **Einstellungen**,
- seine **Commands**: schalte sie an; jeder hat **Öffentlich** / **Nur ich** dafür, wer die Antworten sieht,
- gespeicherte Dateien (z. B. Backups) zum Herunterladen.

## Schlüssel

Plugins, die externe Dienste nutzen (AI Chat, ArcEnCiel, Plex, Forge, Weather, …), brauchen [Secrets](/docs/plugins/secrets).
