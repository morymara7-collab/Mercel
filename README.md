# Caisse Atelier Mercel — version serveur

Application de caisse / gestion d'atelier pour MERCEL GUINÉE (atelier de maintenance
mécanique, Kankan). Serveur Python (bibliothèque standard uniquement) + SQLite,
frontend HTML/CSS/JS sans framework.

## Fonctionnalités
- Connexion par code numérique : rôle **administrateur** ou **caissière**
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

## Lancer en local
```
ADMIN_CODE_DEFAULT=1234 CAISSE_CODE_DEFAULT=5678 python3 server.py
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
