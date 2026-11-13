// The ES5 twin of ./menu-fit.ts, for inline page scripts (no DOM types needed to import it).
/**
 * The same, as ES5 source for pages whose script is an inline string (profile): defines
 * `fitToViewport(el)` in that script's scope.
 */
export const FIT_TO_VIEWPORT_ES5 =
  "function fitToViewport(el){if(!el)return;var s=el.style;s.removeProperty('translate');s.removeProperty('max-inline-size');s.removeProperty('max-block-size');if(el.hidden||!el.getClientRects().length)return;var vw=document.documentElement.clientWidth,vh=window.innerHeight,g=8,r=el.getBoundingClientRect();if(r.width>vw-2*g){s.maxInlineSize=(vw-2*g)+'px';r=el.getBoundingClientRect()}var dx=r.left<g?g-r.left:r.right>vw-g?vw-g-r.right:0;if(dx)s.translate=Math.round(dx)+'px 0';var room=Math.floor(vh-Math.max(r.top,0)-g),max=parseFloat(getComputedStyle(el).maxBlockSize);if(!(max<=room))s.maxBlockSize=Math.max(room,96)+'px'}";
