---
title: Module, Commands und Rechte
summary: Funktionen einschalten, einrichten, speichern und festlegen, wer einen Command nutzen darf.
---
Module sind fertige Funktionen. Öffne **Module** in der Seitenleiste: sie sind nach Kategorien sortiert (Utility, Security, Moderation, Fun, Social, Messages, …).

## Ein Modul einschalten

Der Schalter auf einer Modulkarte schaltet das ganze Modul für den gewählten Bot an oder aus. **Bearbeiten →** öffnet seine Seite:

- der große Schalter oben (derselbe wie auf der Karte),
- die **Einstellungen** des Moduls,
- seine **Commands**, jeder mit eigenem Schalter,
- oft ein kurzes *So funktioniert es*.

Ein Modul arbeitet, sobald seine Einstellungen mindestens einmal **gespeichert** wurden. Änderungen erscheinen unten in der **Speicherleiste**: *Änderungen speichern* oder *Verwerfen*.

## Commands

Modul-Commands sind anfangs aus. Schalte die gewünschten an; Discord zeigt sie nach ein paar Sekunden. Das Zahnrad öffnet den Command.

Jeder Modul-Command ist ein normaler Command des **Command Builders**: du kannst dort seine Antworten und seine Logik ändern. Ein geänderter Command behält deine Version, wenn BotHub aktualisiert wird.

## Wer einen Command nutzen darf

Viele Einstellungsseiten haben einen **Rechte**-Block:

- **Erlaubte Rollen**: nur Mitglieder mit einer dieser Rollen (oder *@everyone*).
- **Gesperrte Rollen**: Mitglieder mit einer dieser Rollen dürfen nicht.
- **Benötigte Rechte**: Discord-Rechte, die das Mitglied braucht (z. B. *Mitglieder bannen*).
- **Gesperrte Channels**: Channels, in denen der Command nicht funktioniert.

## Ein Modul finden

Jedes Modul hat in den Docs eine eigene Seite mit allen Einstellungen und Commands: siehe [Module](/docs/modules).
