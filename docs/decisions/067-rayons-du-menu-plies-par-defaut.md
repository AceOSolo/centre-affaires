# ADR 067 — Rayons du menu pliés par défaut

**Date** : 2026-11-04
**Statut** : accepté — amende l'ADR 064 § 1 (« Par défaut, tout est ouvert »)
et § 2 (cookie `menu_plie`)

## Contexte

L'ADR 064 a rendu chaque rayon du menu du back-office pliable, tout ouvert par
défaut, et avait écarté « tout plié par défaut ». Le responsable produit
demande l'inverse le jour même : à l'arrivée, les rayons sont fermés.

## Décision

- **Tout rayon pliable est plié tant qu'on ne l'a pas ouvert.** « Aujourd'hui »,
  « Demandes » et « Réglages », qui ne se plient pas (ADR 064), restent
  visibles.
- **Le rayon de la page en cours reste ouvert à l'arrivée**, comme dans
  l'ADR 064 : on ne perd jamais de vue où l'on est. Il se plie à la main, et
  se rouvre à la page suivante du même rayon. Quitter ce rayon le replie, sauf
  si on l'avait ouvert soi-même.
- **Le navigateur retient les rayons ouverts**, et non plus les rayons pliés :
  cookie `menu_ouvert`, mêmes règles que l'ADR 064 § 2 (un an, `path=/`,
  `SameSite=Lax`, `Secure` en HTTPS, lu au rendu serveur, clés
  `[a-z0-9-]`, vingt au plus).

## Justification

**Un cookie au nom nouveau.** L'ancien `menu_plie` liste les rayons pliés ;
relu comme une liste de rayons ouverts, il ouvrirait justement ceux qu'un
membre avait fermés. Il est ignoré et expire seul.

**Le rayon en cours toujours ouvert.** Tout plié sans exception masquerait
l'entrée active : le membre ne verrait plus dans quel rayon il se trouve.

## Alternatives écartées

**Garder `menu_plie` et ne plier que les nouveaux venus.** Il faudrait
distinguer « rien plié » de « jamais venu », et un membre qui avait tout
rouvert ne verrait aucun changement.

## Conséquences

- Les préférences de pliage enregistrées depuis l'ADR 064 (le jour même) sont
  perdues : chaque membre retrouve un menu plié.
- Un rayon ajouté au menu (Matériel, lot 6) arrive plié, sans retouche.
- `nav-plie.test.ts` vérifie que chaque rayon pliable de `menu.ts` est plié
  sans cookie. Aucune migration.
