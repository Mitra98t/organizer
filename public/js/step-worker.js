// Converte un file STEP in triangoli con OpenCascade (occt-import-js), fuori dal thread della pagina:
// un modello grande può richiedere secondi. Riceve il file, risponde con le mesh (o con l'errore).
importScripts('../vendor/occt/occt-import-js.js');
/* global occtimportjs */
const ready = occtimportjs({ locateFile: f => `../vendor/occt/${f}` });

onmessage = async ev => {
  try {
    const occt = await ready;
    const r = occt.ReadStepFile(new Uint8Array(ev.data), null);
    if (!r.success) throw new Error('file STEP non leggibile');
    const meshes = r.meshes.map(m => ({
      color: m.color || null,
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
    }));
    postMessage({ meshes }, meshes.flatMap(m => [m.position.buffer, m.normal?.buffer, m.index.buffer].filter(Boolean)));
  } catch (e) {
    postMessage({ error: e.message || String(e) });
  }
};
