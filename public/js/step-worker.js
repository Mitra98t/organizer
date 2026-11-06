// Converts a STEP file into triangles with OpenCascade (occt-import-js), off the page's thread: a large model can
// take seconds. It receives the file and answers with the meshes (or with the error).
importScripts('../vendor/occt/occt-import-js.js');
/* global occtimportjs */
const ready = occtimportjs({ locateFile: f => `../vendor/occt/${f}` });

onmessage = async ev => {
  try {
    const occt = await ready;
    const r = occt.ReadStepFile(new Uint8Array(ev.data), null);
    if (!r.success) throw new Error('unreadable STEP file');
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
