// Archive ZIP sans compression (méthode « stockée ») : les JPEG sont déjà compressés, donc on se contente de les
// emballer. Fonctionne dans le navigateur et dans Node (tests). Limité à 4 Go et 65 535 fichiers (ZIP classique) ;
// le projet affiche au plus 500 photos.

const TABLE_CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(octets) {
  let c = 0xffffffff;
  for (let i = 0; i < octets.length; i += 1) c = TABLE_CRC[(c ^ octets[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Date et heure au format MS-DOS (heure locale, à 2 secondes près).
function dateDos(d) {
  const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const jour = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [heure, jour];
}

// Archive construite photo par photo : seul le Blob de chaque photo est gardé (le navigateur peut le garder sur
// disque), pas une copie en mémoire, pour que 300 photos ne fassent pas planter un téléphone.
export class ArchiveZip {
  #morceaux = [];
  #central = [];
  #position = 0;
  #nb = 0;

  // contenu : un Blob (ex. un JPEG). date : la date de la photo.
  async ajouter(chemin, contenu, date = new Date()) {
    const nom = new TextEncoder().encode(chemin);
    const crc = crc32(new Uint8Array(await contenu.arrayBuffer()));
    const taille = contenu.size;
    const [heure, jour] = dateDos(date);
    const entete = new DataView(new ArrayBuffer(30));
    entete.setUint32(0, 0x04034b50, true);
    entete.setUint16(4, 20, true);
    entete.setUint16(6, 0x0800, true); // noms en UTF-8 (accents)
    entete.setUint16(10, heure, true);
    entete.setUint16(12, jour, true);
    entete.setUint32(14, crc, true);
    entete.setUint32(18, taille, true);
    entete.setUint32(22, taille, true);
    entete.setUint16(26, nom.length, true);
    this.#morceaux.push(entete, nom, contenu);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, heure, true);
    c.setUint16(14, jour, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, taille, true);
    c.setUint32(24, taille, true);
    c.setUint16(28, nom.length, true);
    c.setUint32(42, this.#position, true);
    this.#central.push(c, nom);
    this.#position += 30 + nom.length + taille;
    this.#nb += 1;
  }

  get nombre() { return this.#nb; }

  blob() {
    const tailleCentral = this.#central.reduce((t, m) => t + m.byteLength, 0);
    const fin = new DataView(new ArrayBuffer(22));
    fin.setUint32(0, 0x06054b50, true);
    fin.setUint16(8, this.#nb, true);
    fin.setUint16(10, this.#nb, true);
    fin.setUint32(12, tailleCentral, true);
    fin.setUint32(16, this.#position, true);
    return new Blob([...this.#morceaux, ...this.#central, fin], { type: 'application/zip' });
  }
}
