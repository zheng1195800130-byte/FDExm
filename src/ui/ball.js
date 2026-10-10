import {request} from './shared.js';
const ball=document.getElementById('fde-ball');let drag=null,moved=false;
ball.addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={x:event.screenX,y:event.screenY,startX:event.screenX,startY:event.screenY};moved=false;ball.setPointerCapture(event.pointerId);});
ball.addEventListener('pointermove',event=>{if(!drag)return;const dx=event.screenX-drag.x,dy=event.screenY-drag.y;if(Math.abs(event.screenX-drag.startX)+Math.abs(event.screenY-drag.startY)>5)moved=true;if(moved&&(dx||dy)){request('window:move',{dx,dy}).catch(()=>{});drag.x=event.screenX;drag.y=event.screenY;}});
ball.addEventListener('pointerup',event=>{if(!drag)return;const wasMoved=moved;drag=null;ball.releasePointerCapture(event.pointerId);if(!wasMoved)request('window:panel').catch(()=>{});});
ball.addEventListener('pointercancel',()=>{drag=null;});
ball.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();request('window:panel').catch(()=>{});}});
