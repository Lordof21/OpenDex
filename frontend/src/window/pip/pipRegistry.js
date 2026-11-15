// Hangi pencerelerin görüntüsü şu an bir PiP penceresinde? Ana pencere bunu kendi store'unda bilmez (PiP ayrı bir webview); ama bazı işler
// o pencere için ANA pencerede yapılmamalıdır: örn. telefondan geri dönünce "pencereyi kendi kutusuna göre uzlaştır" — akışı gösteren PiP'tir,
// DeX penceresinin kutusuna göre boyut istemek PiP'in görüntüsünü bozar.

const open = new Set();

export const markPipOpen = (windowId) => { open.add(windowId); };
export const markPipClosed = (windowId) => { open.delete(windowId); };
export const isInPip = (windowId) => open.has(windowId);
