// Same geometry as tackCross() in the app: our course after the tack (TWD 222 - 42 = 180), 6 s late, against each boat
// on our tack (HDG 264) at our speed (BSP 7.4). + = we pass ahead of it, − = behind. Boat length 9.6 m (Cape 31).
const j=require("./labels.json"),D=Math.PI/180,KN=1.943844;
const hdg=264,twd=222,beat=42,bsp=7.4,loss=6,BL=9.6;
const h2=twd-beat,v=bsp/KN,u=[Math.sin(h2*D),Math.cos(h2*D)],W=[u[0]*v,u[1]*v],P0=[-u[0]*v*loss,-u[1]*v*loss];
const V=[Math.sin(hdg*D)*v,Math.cos(hdg*D)*v],cr=(p,q)=>p[0]*q[1]-p[1]*q[0];
function margin(brg,dist){const R=[Math.sin(brg*D)*dist,Math.cos(brg*D)*dist],den=cr(W,V),Dd=[R[0]-P0[0],R[1]-P0[1]];
  const s=cr(Dd,V)/den,tau=cr(Dd,W)/den;if(s<loss||s>600)return null;return {m:v*(tau-s),t:s};}
const per={};
j.frames.forEach(f=>f.labs.forEach(l=>{if(l.dist>600)return;const r=margin(l.brg,l.dist);l.margin=r?r.m:null;l.tx=r?r.t:null;
  if(r)(per[l.id]=per[l.id]||[]).push(r.m);}));
const med=a=>a.slice().sort((x,y)=>x-y)[a.length>>1];
Object.keys(per).forEach(id=>console.log("T"+id,"n="+per[id].length,"median",med(per[id]).toFixed(0)+" m =",(med(per[id])/BL).toFixed(1)+"L"));
j.med={};Object.keys(per).forEach(id=>j.med[id]=med(per[id]));
require("fs").writeFileSync("labels-m.json",JSON.stringify(j));
