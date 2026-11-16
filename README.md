# Caisse Atelier Mercel — version serveur

Application de caisse / gestion d'atelier pour MERCEL GUINÉE (atelier de maintenance
mécanique, Kankan). Serveur Python (bibliothèque standard uniquement) + SQLite,
frontend HTML/CSS/JS sans framework.

## Fonctionnalités
- Connexion par code numérique : rôle **administrateur**, **caissière** ou **associé**
- Création de reçu : client, véhicule (type, marque, immatriculation), kilométrage
  actuel et prochaine vidange, travaux effectués (plusieurs possibles), technicien,
  pièces/consommables (dont l'huile moteur, traitée comme une pièce normale), main
  d'œuvre
- Historique des reçus, annulation (admin, motif obligatoire, remet le stock à jour)
- Stock : ajout, achat (+quantité, mise à jour des prix), **suppression d'un article
  (admin, motif obligatoire)**, alerte de stock bas
- Bilan (admin) : ventes du jour/mois/depuis le début, valeur du stock, litres
  d'huile moteur vendus et restants
- Journal d'audit de toutes les actions sensibles
- Envoi du reçu par WhatsApp, impression A4 du reçu

## Rôle Associé (suivi en direct, lecture seule)
- Se connecte avec son propre code (à créer dans Administration → « Code Associé », ou à la configuration initiale).
- Voit tout : activité en direct, bilan, historique des reçus, stock avec prix, journal des modifications.
- **Ne peut rien modifier** : le serveur refuse toute écriture venant de ce rôle (même si quelqu'un contourne l'écran).
- **Notifié après chaque modification** : chaque reçu, annulation, achat/ajout/suppression de stock ou changement de code apparaît
  dans l'onglet *Activité* en quelques secondes (rafraîchissement toutes les 5 s), avec un message à l'écran, un bip,
  un compteur sur l'onglet et, si l'appareil l'autorise, une notification du navigateur.
- **Alerte sur téléphone même application fermée (optionnel, gratuit) : Telegram.**
  1. Dans Telegram, parler à @BotFather → `/newbot` → copier le *token*.
  2. L'associé écrit un message à ce bot, puis ouvre `https://api.telegram.org/bot<TOKEN>/getUpdates` pour lire son `chat.id`
     (pour un groupe : ajouter le bot au groupe et lire l'id du groupe).
  3. Définir les variables `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` sur le serveur (Render → Environment). Redémarrer.
  Chaque modification envoie alors un message Telegram.

## Lancer en local
```
ADMIN_CODE_DEFAULT=1234 CAISSE_CODE_DEFAULT=5678 ASSOCIE_CODE_DEFAULT=9012 python3 server.py
```
Ouvrir http://localhost:8000 — les codes par défaut ne sont utilisés que si la base
est vide (première fois). Ensuite, tout se configure depuis l'écran de configuration
initiale ou l'onglet Administration.

## Déploiement sur Render.com
Le dépôt contient `Dockerfile` et `render.yaml`. `render.yaml` déclare un disque
persistant (1 Go, monté sur `/data`) pour que les ventes et le stock ne soient
jamais perdus — cela nécessite un plan payant Render (~7$/mois), car Render ne
propose pas de disque persistant sur son plan gratuit. Voir la conversation pour
les étapes détaillées de mise en ligne.

## Données
Base SQLite dans `DATA_DIR` (par défaut `./data/atelier.db`, ou `/data` dans le
conteneur Docker/Render). Pas de dépendance externe.
