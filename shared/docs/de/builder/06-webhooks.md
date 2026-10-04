---
title: Webhooks
summary: Andere Dienste deine Blöcke starten lassen.
---
**Webhooks** (Module → Utility) geben dir URLs, die andere Dienste mit einer **POST**-Anfrage aufrufen können: eine CI-Pipeline, eine Hausautomation, ein Formular.

1. **Webhook hinzufügen**: gib ihm einen Namen. Der letzte Teil der URL ist zufällig (16 bis 40 Buchstaben und Ziffern) und wirkt wie ein Passwort; ein Webhook kann zusätzlich einen **Schlüssel** verlangen.
2. Was dann passiert, baust du als **Custom Event** vom Typ *Wenn ein Webhook aufgerufen wird* und wählst dort den Webhook. Die Anfrage steht als `{webhook.name}`, `{webhook.body}` (der rohe Inhalt) und `{webhook.json}` bereit.
3. Teste ihn mit der **Beispiel-Anfrage** der Seite. Ausgeschaltet lehnt die URL Aufrufe ab.

> [!WARNING]
> Behandle URL und Schlüssel wie Passwörter. Erstell einen neuen, wenn er bekannt wurde.
