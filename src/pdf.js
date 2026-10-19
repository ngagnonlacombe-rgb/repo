// Assemble des photos JPEG (pages scannées) en un PDF, sans dépendance : chaque page affiche une image.

// Largeur et hauteur d'un JPEG, lues dans son en-tête SOF.
export function tailleJpeg(octets) {
  if (octets[0] !== 0xff || octets[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < octets.length) {
    if (octets[i] !== 0xff) { i += 1; continue; }
    const marqueur = octets[i + 1];
    const longueur = octets.readUInt16BE(i + 2);
    // SOF0 à SOF15, sauf DHT (C4), JPG (C8) et DAC (CC).
    if (marqueur >= 0xc0 && marqueur <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marqueur)) {
      return { hauteur: octets.readUInt16BE(i + 5), largeur: octets.readUInt16BE(i + 7), composantes: octets[i + 9] };
    }
    i += 2 + longueur;
  }
  return null;
}

// Texte pour la police Helvetica standard (encodage WinAnsi) : accents français, guillemets et tirets compris.
const WIN_ANSI = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, 'œ': 0x9c, 'Œ': 0x8c };
function chaine(texte) {
  const octets = [...texte].map((c) => {
    const code = c.codePointAt(0);
    return WIN_ANSI[c] ?? (code >= 32 && code <= 255 && !(code >= 0x7f && code <= 0x9f) ? code : 0x3f);
  });
  // Échappe \, ( et ) à l'intérieur d'une chaîne PDF.
  return `(${Buffer.from(octets).toString('latin1').replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

// Coupe une note en lignes d'au plus `max` caractères, sur les espaces.
function couper(texte, max) {
  const lignes = [];
  for (const paragraphe of texte.split(/\r?\n/)) {
    let ligne = '';
    for (const mot of paragraphe.split(/\s+/).filter(Boolean)) {
      for (let morceau = mot; morceau; morceau = morceau.slice(max)) {
        const bout = morceau.slice(0, max);
        if (ligne && `${ligne} ${bout}`.length > max) { lignes.push(ligne); ligne = bout; } else ligne = ligne ? `${ligne} ${bout}` : bout;
      }
    }
    lignes.push(ligne);
  }
  return lignes;
}

// legendes[i] (facultatif) : { meta, note } écrits sous la photo de la page i.
export function pdfDePages(jpegs, legendes = []) {
  const morceaux = [];
  const positions = [];
  let taille = 0;
  const ecrire = (b) => { const t = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); morceaux.push(t); taille += t.length; };
  const objet = (n, contenu, flux) => {
    positions[n] = taille;
    ecrire(`${n} 0 obj\n${contenu}\n`);
    if (flux) { ecrire('stream\n'); ecrire(flux); ecrire('\nendstream\n'); }
    ecrire('endobj\n');
  };

  ecrire('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pages = jpegs.map((jpeg, i) => {
    const dim = tailleJpeg(jpeg);
    if (!dim) throw new Error(`La page ${i + 1} n'est pas une image JPEG valide.`);
    return { jpeg, ...dim, page: 3 + i * 3, image: 4 + i * 3, dessin: 5 + i * 3 };
  });
  objet(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objet(2, `<< /Type /Pages /Kids [${pages.map((p) => `${p.page} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const police = 3 + pages.length * 3;
  for (const [i, p] of pages.entries()) {
    // Page de 612 points de large (format lettre), hauteur selon les proportions de la photo, plus la légende en dessous.
    const l = 612;
    const h = Math.round((612 * p.hauteur) / p.largeur);
    const meta = legendes[i]?.meta?.trim() || '';
    const note = legendes[i]?.note?.trim() ? couper(legendes[i].note.trim(), 95) : [];
    const texte = [];
    let y = 0;
    if (meta || note.length) {
      // Marges de 24 pt, 9 pt gris pour la date et l'auteur, 11 pt noir pour la note.
      y = 24 + (meta ? 13 : 0) + note.length * 14 + 8;
      let ligne = y - 8 - (meta ? 9 : 11);
      if (meta) { texte.push(`BT /F1 9 Tf 0.4 g 24 ${ligne} Td ${chaine(meta)} Tj ET`); ligne -= 15; }
      for (const n of note) { texte.push(`BT /F1 11 Tf 0 g 24 ${ligne} Td ${chaine(n)} Tj ET`); ligne -= 14; }
    }
    const couleurs = p.composantes === 1 ? '/DeviceGray' : p.composantes === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const dessin = [`q ${l} 0 0 ${h} 0 ${y} cm /Im0 Do Q`, ...texte].join('\n');
    objet(p.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${l} ${h + y}] /Resources << /XObject << /Im0 ${p.image} 0 R >> /Font << /F1 ${police} 0 R >> >> /Contents ${p.dessin} 0 R >>`);
    objet(p.image, `<< /Type /XObject /Subtype /Image /Width ${p.largeur} /Height ${p.hauteur} /ColorSpace ${couleurs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
    objet(p.dessin, `<< /Length ${dessin.length} >>`, dessin);
  }
  objet(police, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const nbObjets = 3 + pages.length * 3;
  const debutXref = taille;
  ecrire(`xref\n0 ${nbObjets + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= nbObjets; n += 1) ecrire(`${String(positions[n]).padStart(10, '0')} 00000 n \n`);
  ecrire(`trailer\n<< /Size ${nbObjets + 1} /Root 1 0 R >>\nstartxref\n${debutXref}\n%%EOF\n`);
  return Buffer.concat(morceaux);
}
