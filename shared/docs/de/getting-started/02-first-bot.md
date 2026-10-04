---
title: Deinen ersten Bot hinzufügen
summary: Discord-Anwendung anlegen, Token eintragen, Bot einladen.
---
## 1. Den Bot bei Discord anlegen

1. Öffne das [Discord Developer Portal](https://discord.com/developers/applications) und klick auf **New Application**.
2. Gib ihm einen Namen, öffne **Bot** und klick auf **Reset Token**. Kopier den Token: er wird nur einmal angezeigt.
3. Schalte unter **Privileged Gateway Intents** den **Server Members Intent**, den **Presence Intent** und den **Message Content Intent** ein. Ohne sie sehen Willkommensnachrichten, Leveling, AutoMod und Nachrichten-Belohnungen keine Mitglieder und Nachrichten; im Log steht dann *Privileged intent … is not enabled*.

> [!WARNING]
> Der Token ist das Passwort deines Bots. Poste ihn nirgends. BotHub speichert ihn verschlüsselt und zeigt ihn nie wieder an.

## 2. In BotHub eintragen

Klick oben links auf die Bot-Auswahl, dann auf **+ Bot hinzufügen**, und füg den Token ein. Name und ID kommen von Discord. Der Bot startet sofort.

## 3. Auf deinen Server einladen

Öffne **Bot einladen** in der Seitenleiste. Der Link fragt die Rechte an, die die Module brauchen. Wähl deinen Server und bestätige.

> [!NOTE]
> Du brauchst auf dem Server das Recht *Server verwalten*, um einen Bot hinzuzufügen.

## 4. Prüfen, ob er läuft

- Der Punkt neben dem Bot-Namen ist grün, solange er online ist.
- **Logs** zeigt den Start und jedes Problem.
- **Server** listet die Server, denen er beigetreten ist.

Weiter: [Module einschalten](/docs/getting-started/modules).
