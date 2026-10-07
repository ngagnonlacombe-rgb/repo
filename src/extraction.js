// Lecture automatique d'une facture (photo ou PDF) avec Claude.
// Sans clé ANTHROPIC_API_KEY, l'app fonctionne quand même : l'employé saisit les montants à la main.
import Anthropic from '@anthropic-ai/sdk';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['est_une_facture', 'fournisseur', 'numero', 'date_facture', 'sous_total', 'tps', 'tvq', 'total', 'categorie'],
  properties: {
    est_une_facture: { type: 'boolean', description: "false si l'image n'est pas une facture ou un reçu lisible" },
    fournisseur: { type: ['string', 'null'], description: 'Nom commercial du fournisseur (ex. RONA, BMR, Home Depot)' },
    numero: { type: ['string', 'null'], description: 'Numéro de facture ou de transaction' },
    date_facture: { type: ['string', 'null'], description: 'Date de la facture au format AAAA-MM-JJ' },
    sous_total: { type: ['number', 'null'], description: 'Montant avant taxes, en dollars' },
    tps: { type: ['number', 'null'], description: 'TPS (5 %) ou TVH, en dollars' },
    tvq: { type: ['number', 'null'], description: 'TVQ (9,975 %), en dollars' },
    total: { type: ['number', 'null'], description: 'Montant total payé, taxes incluses, en dollars' },
    categorie: {
      type: 'string',
      enum: ['carburant', 'materiaux', 'outillage', 'disposition_dechets', 'autre'],
      description: "Nature de l'achat : carburant (essence, diesel), materiaux (bois, quincaillerie, fournitures de chantier), "
        + 'outillage (outils, lames, petit équipement), disposition_dechets (conteneur, écocentre, site de dépôt), sinon autre',
    },
  },
};

const CONSIGNE = `Tu lis une facture ou un reçu de fournisseur d'une entreprise du Québec.
Extrais les champs demandés tels qu'ils apparaissent sur le document. Montants en dollars canadiens, sans symbole.
Si un champ est illisible ou absent, mets null plutôt que de deviner.
La TPS est parfois écrite GST ou TPS/GST ; la TVQ est parfois écrite QST ou TVQ/QST.
Reçu d'essence ou taxes incluses dans le prix : mets null pour sous_total ; donne la TPS et la TVQ seulement si leurs montants
sont imprimés (ex. « TPS incl. dans l'essence »), sinon null. L'app calcule le reste.`;

export function creerLecteur({ cleApi = process.env.ANTHROPIC_API_KEY, client } = {}) {
  if (!client && !cleApi) {
    return { actif: false, async lire() { return null; } };
  }
  const anthropic = client || new Anthropic({ apiKey: cleApi });

  return {
    actif: true,
    async lire(contenu, typeMime) {
      const donnees = contenu.toString('base64');
      const bloc = typeMime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: donnees } }
        : { type: 'image', source: { type: 'base64', media_type: typeMime, data: donnees } };

      const reponse = await anthropic.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 2000,
        // Si la requête est refusée par un filtre de sécurité, l'API la relance sur un autre modèle.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: CONSIGNE,
        messages: [{ role: 'user', content: [bloc, { type: 'text', text: 'Extrais les champs de cette facture.' }] }],
      });

      if (reponse.stop_reason === 'refusal' || reponse.stop_reason === 'max_tokens') return null;
      const texte = reponse.content.find((b) => b.type === 'text')?.text;
      if (!texte) return null;
      const champs = JSON.parse(texte);
      return champs.est_une_facture ? champs : null;
    },
  };
}
