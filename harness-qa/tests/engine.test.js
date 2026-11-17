// Run: node harness-qa/tests/engine.test.js
const assert=require('assert/strict');
const {HQA,html}=require('./load-engine.js');
let pass=0;const test=(name,fn)=>{try{fn();pass++;console.log('✓',name);}catch(e){console.error('✗',name,'\n ',e.message);process.exitCode=1;}};
const D=h=>'type,id,from,to,value,tol,net,note\n'+h.trim();
const T=h=>'step,type,from,to,low,high,unit,voltage,measured,result,note\n'+h.trim();
const run=(d,t,extra={})=>HQA.analyze({drawing:D(d),tests:T(t),...extra});
const codes=r=>r.findings.map(f=>f.key.split('|')[0]);
const metric=(r,k)=>r.metrics.find(m=>m.key===k);
const grab=k=>html.match(new RegExp(k+':`([\\s\\S]*?)`'))[1];

test('quantities and units',()=>{
  assert.equal(HQA.parseQty('3.3k'),3300);
  assert.equal(HQA.parseQty('100M'),1e8);
  assert.equal(HQA.parseQty('12m'),0.012);
  assert.equal(HQA.parseQty('>500 MOhm'),5e8);
  assert.equal(HQA.parseQty('Infinite'),Infinity);
  assert.equal(HQA.unitFactor('mohm'),1e-3);
  assert.equal(HQA.unitFactor('Mohm'),1e6);
  assert.equal(HQA.unitFactor('kΩ'),1e3);
  assert.ok(Number.isNaN(HQA.unitFactor('banana')));
});

test('splice branch must be covered on every leg',()=>{
  const d='WIRE,W1,J1-1,SPL1\nWIRE,W2,SPL1,J2-1\nWIRE,W3,SPL1,J3-1';
  let r=run(d,'1,CONT,J1-1,J2-1,,1');
  assert.ok(r.findings.some(f=>f.msg.includes('ענף פיצול')));
  assert.equal(metric(r,'wires').covered,2);
  r=run(d,'1,CONT,J1-1,J2-1,,1\n2,CONT,J2-1,J3-1,,1\n3,ISO,ALL,ALL,100M');
  assert.equal(r.counts.gap,0);assert.equal(r.counts.critical,0);
});

test('daisy chain: one end-to-end test covers intermediate pin',()=>{
  const r=run('WIRE,W1,J1-1,J2-1\nWIRE,W2,J2-1,J3-1','1,CONT,J1-1,J3-1,,1');
  assert.equal(metric(r,'wires').covered,2);assert.equal(metric(r,'pins').covered,3);
});

test('parallel wires are flagged',()=>{
  const r=run('WIRE,W1,J1-1,J2-1\nWIRE,W2,J1-1,J2-1','1,CONT,J1-1,J2-1,,1');
  assert.ok(codes(r).includes('parallel'));
});

test('continuity across isolated nets is critical',()=>{
  const r=run('WIRE,,J1-1,J2-1\nWIRE,,J1-2,J2-2','1,CONT,J1-1,J2-2,,1');
  assert.ok(codes(r).includes('contiso'));
});

test('unknown test point and NC pin',()=>{
  const r=run('WIRE,,J1-1,J2-1\nNC,,J1-9','1,CONT,J1-1,J9-1,,1\n2,CONT,J1-9,J2-1,,1');
  assert.ok(codes(r).includes('unknownpt'));assert.ok(codes(r).includes('testnc'));
});

test('series resistors: equivalent value and window checks',()=>{
  const d='WIRE,,J1-1,R1-1\nR,R1,R1-1,R1-2,1k,1\nWIRE,,R1-2,R2-1\nR,R2,R2-1,R2-2,2k,1\nWIRE,,R2-2,J2-1';
  let r=run(d,'1,RES,J1-1,J2-1,2.95k,3.05k');
  assert.equal(metric(r,'res').covered,2);
  assert.equal(metric(r,'wires').covered,3,'wires inside the chain are covered by the RES test');
  r=run(d,'1,RES,J1-1,J2-1,1.9k,2.1k');
  assert.ok(codes(r).includes('resout'));
});

test('parallel resistors: a big one in parallel with a small one is not observable',()=>{
  const d='WIRE,,J1-1,R1-1\nWIRE,,J1-1,R2-1\nR,R1,R1-1,R1-2,100,1\nR,R2,R2-1,R2-2,1M,1\nWIRE,,R1-2,J2-1\nWIRE,,R2-2,J2-1';
  const r=run(d,'1,RES,J1-1,J2-1,98,102');
  const t=r.trace.filter(x=>x.type==='נגד');
  assert.equal(t.find(x=>x.id==='R1').status,'מכוסה');
  assert.equal(t.find(x=>x.id==='R2').status,'לא מכוסה');
});

test('resistance test window narrower than tolerance warns',()=>{
  const r=run('R,R1,J1-1,J2-1,100,10','1,RES,J1-1,J2-1,99,101');
  assert.ok(codes(r).includes('resnarrow'));
});

test('diodes: forward, reverse, polarity, missing low limit',()=>{
  const d='D,D1,J1-1,J2-1,0.7';
  let r=run(d,'1,DIODE,J2-1,J1-1,,');
  assert.ok(codes(r).includes('dnofwd'));
  r=run(d,'1,DIODE,J1-1,J2-1,,1.0');
  assert.ok(codes(r).includes('dnolow'));
  r=run(d,'1,DIODE,J1-1,J2-1,0.4,1.0\n2,DIODE,J2-1,J1-1,,\n3,ISO,ALL,ALL,100M');
  assert.equal(metric(r,'diodes').covered,1);
  r=run(d,'1,DIODE,J1-1,J2-1,0.8,1.0');
  assert.ok(codes(r).includes('dvf'));
});

test('isolation: groups joined by components, ALL semantics, same-net iso is critical',()=>{
  const d='WIRE,,J1-1,J2-1\nWIRE,,J1-2,J2-2\nR,R1,J1-3,J2-3,10\nNC,,J1-9';
  let r=run(d,'1,ISO,J1-1,ALL,100M');
  const m=metric(r,'iso');
  // groups: N1, N2, {J1-3,J2-3 via R1}, NC  -> 6 pairs, J1-1 vs 3 others covered
  assert.equal(m.total,6);assert.equal(m.covered,3);
  r=run(d,'1,ISO,J1-1,J2-1,100M');
  assert.ok(codes(r).includes('isosame'));
  r=run(d,'1,ISO,J1-3,J2-3,100M');
  assert.ok(codes(r).includes('isocomp'));
});

test('measured results evaluated against limits',()=>{
  const r=run('WIRE,,J1-1,J2-1','1,CONT,J1-1,J2-1,,1,ohm,,1.5,,');
  assert.ok(codes(r).includes('measfail'));
});

test('net,pin format uses spanning coverage',()=>{
  const r=HQA.analyze({drawing:'net,pin\nN1,J1-1\nN1,J2-1\nN1,J3-1\nN2,J1-2',tests:T('1,CONT,J1-1,J2-1,,1')});
  assert.equal(metric(r,'vnets').covered,0);assert.equal(metric(r,'vnets').total,1);
  assert.ok(r.findings.some(f=>f.key.startsWith('contgap')&&f.msg.includes('J3-1')));
});

test('duplicate net name in disconnected groups is flagged',()=>{
  const r=run('WIRE,,J1-1,J2-1,,,PWR\nWIRE,,J1-5,J3-5,,,PWR','');
  assert.ok(codes(r).includes('netsplit'));
});

test('mechanical cross-check: missing, P/N mismatch, pin range',()=>{
  const r=run('CONN,J1,,,ABC-1\nWIRE,,J1-20,J2-1','1,CONT,J1-20,J2-1,,1',{mech:'ref,part_number,description,pins\nJ1,ABC-2,x,15'});
  const c=codes(r);
  assert.ok(c.includes('pnmis'));assert.ok(c.includes('pinrange'));assert.ok(c.includes('mechmiss'));
});

test('demo: applying suggestions closes every coverage gap',()=>{
  const base={drawing:grab('drawing'),mech:grab('mech'),meta:{drawingRev:'B'}};
  const r1=HQA.analyze({...base,tests:grab('tests')});
  assert.ok(r1.counts.gap>0);
  const extra=r1.suggestions.map((s,i)=>['S'+i,s.type,s.from,s.to,s.low,s.high,s.unit,s.voltage].join(',')).join('\n');
  const r2=HQA.analyze({...base,tests:grab('tests')+'\n'+extra});
  assert.equal(r2.counts.gap,0,r2.findings.filter(f=>f.sev==='gap').map(f=>f.el+': '+f.msg).join('\n'));
  for(const m of r2.metrics.filter(m=>!['mech','mechw'].includes(m.key)))assert.equal(m.covered,m.total,m.label);
});

test('tester HTML report text -> tests -> cross-check',()=>{
  const txt=`Part Number: XM1
Drawing number: XM1-PV
Drawing rev: 05
Conductor Maximum Resistance = 1 Ohm
Net1 (SIDE A - A, SIDE B - A), resistance: 12.5 mOhm
Net2 (SIDE A - B, SIDE B - B), resistance: 1500 mOhm
Net1 (SIDE A - A, SIDE B - A) isolation: Infinite
DC Net1 (SIDE A - A, SIDE B - A): Pass 500V
`;
  const rep=HQA.parseReportText(txt);
  assert.equal(rep.rows.length,2);assert.equal(rep.meta.drawingRev,'05');assert.equal(rep.meta.limit,1);
  const csv=HQA.reportToTestsCsv(rep,'P1','P2');
  const r=HQA.analyze({drawing:D('WIRE,,P1-A,P2-A\nWIRE,,P1-B,P2-B\nWIRE,,P1-C,P2-C'),tests:csv,meta:{drawingRev:'04'},reportMeta:rep.meta});
  const c=codes(r);
  assert.ok(c.includes('measfail'),'Net2 1.5Ω > 1Ω');
  assert.ok(c.includes('idrev'),'revision mismatch');
  assert.ok(r.findings.some(f=>f.key.startsWith('contgap')&&f.msg.includes('P1-C')));
});



/* ---- PDF text reconstruction (items shaped like pdf.js getTextContent output) ---- */
const item=(str,x,y,page=1,h=10)=>({str,t:[h,0,0,h,x,y],w:str.length*h*0.5,page});
test('PDF table: columns, repeated headers, connector+pin join',()=>{
  const items=[];let y=700;
  for(const pg of [1,2]){
    y=700;['WIRE','FROM','PIN','TO','PIN','SIGNAL'].forEach((h,i)=>items.push(item(h,40+i*80,y,pg)));
    for(let k=1;k<=5;k++){y-=16;const n=(pg-1)*5+k;[`W${n}`,'J1',String(n),'J2',String(n),`SIG ${n}`].forEach((v,i)=>items.push(item(v,40+i*80,y,pg)));}
  }
  const tbl=HQA.tableFromLines(HQA.pdfLines(items));
  assert.equal(tbl.cols,6);
  const {map}=HQA.autoMap(tbl,'drawing');
  assert.equal(JSON.stringify(map),JSON.stringify(['id','from','from_pin','to','to_pin','net']));
  const r=HQA.tableToCsv(tbl,map,'drawing',{});
  assert.equal(r.count,10);
  assert.ok(r.csv.includes('חוט,W7,J1-7,J2-7,,,SIG 7,'));
});
test('PDF rotated text is read along its baseline',()=>{
  const rot=(str,x,y)=>({str,t:[0,10,-10,0,x,y],w:str.length*5,page:1});
  const lines=HQA.pdfLines([rot('J5-1',300,100),rot('J6-1',300,180),rot('J5-2',316,100),rot('J6-2',316,180)]);
  assert.equal(lines.map(l=>l.cells.map(c=>c.text).join(' ')).join('|'),'J5-1 J6-1|J5-2 J6-2');
});
test('PDF free text: pairs, type, limits, voltage',()=>{
  const lines=HQA.pdfLines([item('Step 3: Measure insulation J1-1 to all other pins, 500VDC, min 100 MOhm.',50,700),item('Step 1: Check continuity between J1-1 and J2-1. Max 1 Ohm.',50,680)]);
  const recs=HQA.pairsFromLines(lines,'tests');
  assert.equal(recs[0].type,'ISO');assert.equal(recs[0].to,'ALL');assert.equal(recs[0].low,'100MOhm');assert.equal(recs[0].voltage,'500');assert.equal(recs[0].step,'3');
  assert.equal(recs[1].type,'CONT');assert.equal(recs[1].high,'1Ohm');
  const t=HQA.parseTests(HQA.pairsToCsv(recs,'tests')).tests;
  assert.equal(t[0].low,1e8);assert.equal(t[1].high,1);
});
test('PDF table: second page with shifted column positions is aligned',()=>{
  const items=[];
  const put=(pg,xs,rows)=>{let y=700;rows.forEach(r=>{r.forEach((v,i)=>items.push(item(v,xs[i],y,pg)));y-=16;});};
  put(1,[40,120,170,250,300],[['WIRE','FROM','PIN','TO','PIN'],...[1,2,3,4].map(n=>['W'+n,'J1',''+n,'J2',''+n])]);
  put(2,[40,100,140,200,240],[['WIRE','FROM','PIN','TO','PIN'],...[5,6,7,8].map(n=>['W'+n,'J1',''+n,'J2',''+n])]);
  const tbl=HQA.tableFromLines(HQA.pdfLines(items));
  const r=HQA.tableToCsv(tbl,HQA.autoMap(tbl,'drawing').map,'drawing',{});
  assert.equal(r.count,8);assert.ok(r.csv.includes('חוט,W8,J1-8,J2-8'));
});

/* ---- French-style tester log (fictional points, same line format as the real tester) ---- */
const LOG=`Programme de tests porté le : 01/01/2026
* Référence programme : DEMO1.tes *
* Indice schéma éléctrique : B *
Paramètres d'Isolement
Résistance minimum = 100 MΩ
Tension d'isolement = 500 V
Paramètres de Continuité
Résistance minimum = 0 Ω
Résistance maximum = 3 Ω
 Continuité + Test d'Isolement / inférieurs B(J1-9) - BON
 Isolement A(J1-9) B[...] R = 1.868 GΩ
test E1 et E2
 Continuité + Test d'Isolement / inférieurs B(J1-1) ... (J3-1) - BON
 Isolement A(J1-1) B[...] R > 5 GΩ
 Continuité A(J1-1) B(J2-1) R = 1.398 Ω
 Continuité A(J1-1) B(J3-1) R = 1.41 Ω
test E3
 Continuité + Test de Non-Continuité / inférieurs B(J1-4) ... (J2-4) - BON
 Non-continuité A(J1-4) B[...] R > 2 kΩ
 Continuité A(J1-4) B(J2-4) R = 1.2 Ω
 Continuité A(J1-4) B(J2-4B) R = 1.3 Ω
Paramètres de Résistance 4 fils
Résistance minimum = 3.132 Ω
Résistance maximum = 3.828 Ω
 Mesure de Résistance 4 fils A(J2-4) B(J2-5) - R = 3.485 Ω
TEST BON`;
test('tester log: parse continuity / insulation / non-continuity / 4-wire',()=>{
  assert.ok(HQA.isTesterLog(LOG));
  const r=HQA.parseTesterLog(LOG);
  assert.equal(r.stats.CONT,4);assert.equal(r.stats.ISO,2);assert.equal(r.stats.NONCONT,1);assert.equal(r.stats.RES,1);
  assert.equal(r.meta.drawingRev,'B');assert.equal(r.meta.pn,'DEMO1');assert.equal(r.meta.result,'PASS');
  const t=HQA.parseTests(r.csv).tests;
  const iso=t.find(x=>x.type==='ISO'&&x.from==='J1-1');assert.equal(iso.low,1e8);assert.equal(iso.voltage,500);assert.equal(iso.measured,5e9);
  const nc=t.find(x=>x.type==='ISO'&&x.from==='J1-4');assert.equal(nc.low,2000);
  const c=t.find(x=>x.type==='CONT'&&x.to==='J3-1');assert.equal(c.high,3);assert.equal(c.measured,1.41);assert.ok(c.note.includes('E1, E2'));
  const res=t.find(x=>x.type==='RES');assert.equal(res.low,3.132);assert.equal(res.measured,3.485);
});
test('tester log: draft netlist is flagged as unverified and drives a revision check',()=>{
  const r=HQA.parseTesterLog(LOG);const n=HQA.testsToNetlist(r.csv);
  assert.equal(n.nets,4);
  const a=HQA.analyze({drawing:n.csv,tests:r.csv,meta:{drawingRev:'C'},reportMeta:r.meta});
  const c=codes(a);
  assert.ok(c.includes('unverified'));assert.ok(c.includes('idrev'));assert.equal(a.full,false);
  assert.equal(metric(a,'vnets').covered,metric(a,'vnets').total);
  assert.ok(a.findings.some(f=>f.key.startsWith('isoweak')&&f.el.includes('(E3)')),'net tested only by 2kΩ non-continuity');
  // once verified (marker removed), no unverified gap remains
  const b=HQA.analyze({drawing:n.csv.replace(/מהבודק[^\n]*/g,'אומת'),tests:r.csv});
  assert.ok(!codes(b).includes('unverified'));
});

/* ---- Hebrew is the working language; English files keep working ---- */
test('Hebrew demo gives the expected findings',()=>{
  const r=HQA.analyze({drawing:grab('drawing'),tests:grab('tests'),mech:grab('mech'),meta:{drawingRev:'B'}});
  assert.equal(r.counts.critical,4);assert.equal(r.counts.gap,7);
  assert.ok(codes(r).includes('mwgauge')&&codes(r).includes('mwnets'));
  assert.equal(metric(r,'wires').covered,11);assert.equal(metric(r,'iso').covered,30);
});
test('Hebrew and English inputs give identical analysis',()=>{
  const he=HQA.analyze({drawing:'סוג,מזהה,מוצא,יעד,ערך,טולרנס,רשת,הערה\nחוט,,J1-1,SPL1\nחוט,,SPL1,J2-1\nחוט,,SPL1,J3-1\nנגד,R1,J1-2,J2-2,1k,5\nלא מחובר,,J1-9',
    tests:'צעד,סוג,מוצא,יעד,מינימום,מקסימום,יחידה,מתח,נמדד,תוצאה,הערה\n1,רציפות,J1-1,J2-1,,1,אוהם\n2,התנגדות,J1-2,J2-2,0.95,1.05,קילו-אוהם\n3,בידוד,J1-1,כולם,100,,מגה-אוהם,500,1.2 GΩ,עבר'});
  const en=HQA.analyze({drawing:D('WIRE,,J1-1,SPL1\nWIRE,,SPL1,J2-1\nWIRE,,SPL1,J3-1\nR,R1,J1-2,J2-2,1k,5\nNC,,J1-9'),
    tests:T('1,CONT,J1-1,J2-1,,1,ohm\n2,RES,J1-2,J2-2,0.95,1.05,kohm\n3,ISO,J1-1,ALL,100,,Mohm,500,1.2 GΩ,PASS')});
  assert.equal(JSON.stringify(he.counts),JSON.stringify(en.counts));
  assert.equal(JSON.stringify(he.metrics),JSON.stringify(en.metrics));
  assert.equal(JSON.stringify(he.findings.map(f=>f.key)),JSON.stringify(en.findings.map(f=>f.key)));
});
test('generated rows are in Hebrew (suggestions vocabulary, tester log)',()=>{
  const r=HQA.parseTesterLog(LOG);
  assert.ok(r.csv.startsWith('צעד,סוג,מוצא,יעד'));assert.ok(r.csv.includes(',בידוד,J1-1,כולם,'));assert.ok(r.csv.includes(',רציפות,J1-1,J3-1,'));
  assert.ok(HQA.testsToNetlist(r.csv).csv.split('\n')[1].startsWith('רשת,'));
});

test('verification: list nets from the tester draft, mark ok / mismatch, effect on analysis',()=>{
  const r=HQA.parseTesterLog(LOG);let d=HQA.testsToNetlist(r.csv).csv;
  let items=HQA.verifyItems(d);
  assert.equal(items.filter(x=>x.kind==='net').length,4);assert.ok(items.every(x=>x.status==='open'));
  const net=items.find(x=>x.points.includes('J3-1'));assert.equal(net.labels,'E1,E2');
  d=HQA.setVerify(d,net.key,{status:'ok',sheet:'2',zone:'C4'});
  const other=items.find(x=>x.points.includes('J1-9'));
  d=HQA.setVerify(d,other.key,{status:'bad',note:'J1-9 מחובר בשרטוט ל־J5-3'});
  items=HQA.verifyItems(d);
  const ok=items.find(x=>x.key===net.key);assert.equal(ok.status,'ok');assert.equal(ok.sheet,'2');assert.equal(ok.zone,'C4');
  assert.equal(items.find(x=>x.key===other.key).status,'bad');
  const a=HQA.analyze({drawing:d,tests:r.csv});
  const bad=a.findings.find(f=>f.key.startsWith('verifybad'));assert.ok(bad&&bad.sev==='critical'&&bad.msg.includes('J5-3'));
  const unv=a.findings.find(f=>f.key.startsWith('unverified'));assert.ok(unv);
  // the 3 rows of the verified net and the mismatched row are no longer counted as unverified
  const before=HQA.analyze({drawing:HQA.testsToNetlist(r.csv).csv,tests:r.csv}).findings.find(f=>f.key.startsWith('unverified'));
  assert.equal(parseInt(before.el)-parseInt(unv.el),4);
  // undo returns the net to open
  d=HQA.setVerify(d,net.key,{status:'open'});assert.equal(HQA.verifyItems(d).find(x=>x.key===net.key).status,'open');
});

test('4-wire second contacts (<pin>B) are folded onto the pin',()=>{
  const r=HQA.parseTesterLog(LOG);
  assert.equal(r.stats.kelvin.join(),'J2-4B→J2-4');
  assert.ok(!r.csv.includes('J2-4B,'),'no J2-4B point in the generated tests');
  assert.ok(r.csv.includes('מגע 4 חוטים J2-4B = J2-4'));
  const n=HQA.testsToNetlist(r.csv);assert.ok(!n.csv.includes('J2-4B'));
  // analysis against a real drawing: a <pin>B point in the program becomes the pin, as info
  const a=run('WIRE,,J1-4,J2-4\nR,R1,J2-4,J2-5,3.48,10','1,CONT,J1-4,J2-4B,,1\n2,RES,J2-4,J2-5,3.132,3.828');
  const c=codes(a);assert.ok(c.includes('kelvin'));assert.ok(!c.includes('unknownpt'));
  assert.equal(metric(a,'wires').covered,1);
  // a B-point without a 4-wire measurement on its base is still an unknown point
  const b=run('WIRE,,J1-4,J2-4','1,CONT,J1-4,J2-4B,,1');assert.ok(codes(b).includes('unknownpt'));
});

test('QA report: sections, verdict, metrics, reviews, escaping',()=>{
  const res=HQA.analyze({drawing:grab('drawing'),tests:grab('tests'),mech:grab('mech'),meta:{drawingRev:'B'}});
  const f=res.findings[0];
  const html=HQA.reportHtml({meta:{pn:'DEMO-100',drawingRev:'B',inspector:'<b>x</b>',notes:'a & b'},res,reviews:{[f.key]:{status:'סגור',note:'ראיה "1"'}},
    verify:{total:3,ok:1,bad:1,open:1,badList:[{name:'N2',points:['J1-1'],sheet:'2',zone:'C4',note:'חסר חיבור'}]},date:'1.1.2026',reportNo:'HQA-DEMO-1',reviewLabels:['פתוח','סגור']});
  for(const t of ['דוח ביקורת איכות','1. פרטי הפריט','3. מסקנה וכיסוי','4. אימות רשימת החיבורים','5. ממצאים','אישורים','HQA-DEMO-1','חוטים שכוסו ברציפות','חסר חיבור','גיליון 2, אזור C4'])assert.ok(html.includes(t),t);
  assert.ok(html.includes('v-bad'),'critical verdict styling');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;')&&!html.includes('<b>x</b>'),'inspector name escaped');
  assert.ok(html.includes('a &amp; b')&&html.includes('ראיה &quot;1&quot;'));
  assert.equal((html.match(/<tr><td>\d+<\/td><td><span class="sev/g)||[]).length,res.findings.length,'one row per finding');
  const doc=HQA.reportDocument(html,'t');assert.ok(doc.startsWith('<!doctype html>')&&doc.includes('dir="rtl"')&&doc.includes('.qa-doc'));
});

/* ---- mechanical drawing: wire table ---- */
const MH='מזהה,מק״ט,תיאור,מגעים,כמות,מוצא,יעד,חתך,צבע,אורך\n';
test('mechanical wire table: same net, gauge, ends, unknown points, electrical wires missing',()=>{
  const d='WIRE,W1,J1-1,SPL1\nWIRE,W2,SPL1,J2-1\nWIRE,W3,J1-2,J2-2\nWIRE,W4,J1-3,J2-3';
  const dg='type,id,from,to,value,tol,net,note,gauge\nWIRE,W1,J1-1,SPL1,,,,,22\nWIRE,W2,SPL1,J2-1,,,,,22\nWIRE,W3,J1-2,J2-2,,,,,#20\nWIRE,W4,J1-3,J2-3,,,,,24';
  const mech=MH+'J1,X,,,1,,,,,\nW1,,,,,J1-1,SPL1,22,,\nW2,,,,,SPL1,J2-1,AWG 22,,\nW3,,,,,J1-2,J2-2,20,,\nW9,,,,,J1-3,J2-2,24,,\nW7,,,,,J1-3,J9-9,24,,';
  const r=HQA.analyze({drawing:dg,tests:T('1,CONT,J1-1,J2-1,,1'),mech});
  const c=codes(r);
  assert.ok(c.includes('mwnets'),'W9 joins two electrical nets');
  assert.ok(c.includes('mwunknown'),'J9-9 is not in the electrical drawing');
  assert.ok(!c.includes('mwgauge'),'"AWG 22" = "22", "#20" = "20"');
  assert.ok(r.findings.some(f=>f.key.startsWith('mwmissing')&&f.msg.includes('W4')));
  assert.equal(metric(r,'mechw').covered,3);assert.equal(metric(r,'mechw').total,5);
  assert.equal(metric(r,'mech').total>0,true);
  // gauge mismatch
  const g=HQA.analyze({drawing:dg,tests:'',mech:MH+'W4,,,,,J1-3,J2-3,22,,'});
  assert.ok(codes(g).includes('mwgauge'));
  // same id, different ends
  const e=HQA.analyze({drawing:dg,tests:'',mech:MH+'W3,,,,,J1-2,J1-1,20,,'});
  assert.ok(codes(e).includes('mwends'));
});
test('mechanical wire to a splice is matched to the tester-draft net by its splice label',()=>{
  const r=HQA.parseTesterLog(LOG);const d=HQA.testsToNetlist(r.csv).csv;   // net with J1-1,J2-1,J3-1 is labelled (E1,E2)
  const ok=HQA.analyze({drawing:d,tests:r.csv,mech:MH+'W1,,,,,J1-1,E1,22,,\nW2,,,,,E2,J3-1,22,,'});
  assert.equal(metric(ok,'mechw').covered,2);
  const bad=HQA.analyze({drawing:d,tests:r.csv,mech:MH+'W5,,,,,J1-4,E1,22,,'});
  assert.ok(codes(bad).includes('mwnets'),'J1-4 is on another net than splice E1');
  const unk=HQA.analyze({drawing:d,tests:r.csv,mech:MH+'W6,,,,,J1-1,E77,22,,'});
  assert.ok(codes(unk).includes('mwsplice')&&!codes(unk).includes('mwunknown'));
});
test('PDF import of a mechanical wire table (WIRE NO / FROM / PIN / TO / PIN / AWG / COLOR / LENGTH)',()=>{
  const items=[];let y=700;
  ['WIRE NO','FROM','PIN','TO','PIN','AWG','COLOR','LENGTH (mm)'].forEach((h,i)=>items.push(item(h,40+i*70,y)));
  for(let k=1;k<=4;k++){y-=16;['W'+k,'J1',''+k,'J2',''+k,'22','WHT',''+(100*k)].forEach((v,i)=>items.push(item(v,40+i*70,y)));}
  const tbl=HQA.tableFromLines(HQA.pdfLines(items));const {map}=HQA.autoMap(tbl,'mech');
  assert.equal(JSON.stringify(map),JSON.stringify(['ref','from','from_pin','to','to_pin','gauge','color','length']));
  const out=HQA.tableToCsv(tbl,map,'mech',{});assert.equal(out.count,4);
  assert.ok(out.csv.includes('W3,,,,,J1-3,J2-3,22,WHT,300'));
  const m=HQA.parseMech(out.csv);assert.equal(m[0].from,'J1-1');assert.equal(m[0].gauge,'22');
});

test('PDF import of a mechanical BOM: ITEM is not the reference designator',()=>{
  const items=[];let y=700;
  ['ITEM','REF DES','PART NUMBER','DESCRIPTION','QTY'].forEach((h,i)=>items.push(item(h,40+i*90,y)));
  [['1','J1','M83723','CONNECTOR','1'],['2','R1','RCR07','RESISTOR','1']].forEach(r=>{y-=16;r.forEach((v,i)=>items.push(item(v,40+i*90,y)));});
  const tbl=HQA.tableFromLines(HQA.pdfLines(items));const {map}=HQA.autoMap(tbl,'mech');
  assert.equal(JSON.stringify(map),JSON.stringify(['','ref','pn','desc','qty']));
});

/* ---- AS9102 FAI ---- */
const grabObj=k=>html.match(new RegExp(k+':`([\\s\\S]*?)`'))[1];
test('FAI requirement parser: +x, -a+b, ±, min/max, ranges, exact, text',()=>{
  const r=x=>{const q=HQA.parseReq(x);return q?[q.lo,q.hi,!!q.exact].join(','):'null';};
  assert.equal(r('280 MM + 5 MM'),'280,285,false');
  assert.equal(r('10000 -0+50 mm'),'10000,10050,false');
  assert.equal(r('5000 -0+50 mm'),'5000,5050,false');
  assert.equal(r('12.5±0.2'),'12.3,12.7,false');
  assert.equal(r('20 +5/-2 mm'),'18,25,false');
  assert.equal(r('min 10'),'10,Infinity,false');
  assert.equal(r('3.1–3.6'),'3.1,3.6,false');
  assert.equal(r('180°'),'180,180,true');
  assert.equal(r('ALL DIMENSIONS IN MM'),'null');
  assert.equal(r('DEMO-100 REV B'),'null');
});
test('FAI dates: dd/mm/yy, dd.mm.yyyy, month-year expiry',()=>{
  assert.equal(HQA.parseDate('25/03/26').toISOString().slice(0,10),new Date(2026,2,25).toISOString().slice(0,10));
  assert.equal(HQA.parseDate('24.03.25').getFullYear(),2025);
  const e=HQA.parseDate('EXP.06.2027');assert.equal(e.getMonth(),5);assert.equal(e.getDate(),30);
});
test('FAI demo: every planted issue is found',()=>{
  const faiH={pn:'DEMO-100',partName:'רתמת הדגמה',sn:'SN-0001',fairId:'FAIR-001',partRev:'B',drawingNo:'DEMO-100-M',drawingRev:'B',org:'מפעל לדוגמה',kind:'מכלול',faiType:'מלא',nc:'',verifiedBy:'א',verifiedDate:'10/03/2026',reviewedBy:'ב',reviewedDate:'08/03/2026',testProc:'ATP-DEMO-100',acceptReport:'ATP-DEMO-100'};
  const r=HQA.analyze({drawing:grab('drawing'),tests:grab('tests'),mech:grab('mech'),meta:{pn:'DEMO-100',mechNo:'DEMO-100-M',mechRev:'B',drawingRev:'B'},faiH,fai1:grabObj('fai1'),fai2:grabObj('fai2'),fai3:grabObj('fai3')});
  const c=codes(r),f=k=>r.findings.find(x=>x.key.startsWith(k));
  assert.ok(f('faireq').msg.includes('19.'),'field 19 not answered');
  assert.ok(c.includes('faidates'),'review date before verification date');
  assert.ok(c.includes('faisameref'),'same procedure and report number');
  assert.equal(f('faiexp').sev,'critical');assert.ok(f('faiexp').el.includes('דבק'));
  assert.ok(f('faibom').msg.includes('RCR07G3R3JS'),'BOM resistor missing from form 1');
  assert.equal(f('faiout').el,'#3');assert.equal(f('faiout').sev,'critical');
  assert.equal(f('fainores').el,'#7');
  assert.ok(f('faigaps').msg.includes('5'));
  assert.ok(!c.includes('fairev')&&!c.includes('faipn')&&!c.includes('faidrawing'),'identity matches the project');
  const m=r.metrics.find(x=>x.key==='faiChar');assert.equal(m.total,7);assert.equal(m.covered,5);
  assert.equal(r.fai.rows.find(x=>x.no==='2').status,'בתחום');
  // field 19 = "no" while form 3 has a deviation -> critical contradiction
  const r2=HQA.analyze({drawing:'',tests:'',faiH:{...faiH,nc:'לא'},fai3:grabObj('fai3')});
  assert.ok(codes(r2).includes('fainc19'));assert.ok(!codes(r2).includes('nodraw'),'FAI-only run needs no drawing');
  // deviation recorded with a nonconformance number is a warning, not critical
  const r3=HQA.analyze({drawing:'',tests:'',faiH,fai3:'מס׳,מיקום בשרטוט,מאפיין,דרישה,תוצאה,כלי,אי־התאמה,הערה\n1,B3,אורך,400 -0+50 mm,460 mm,סרט,NCR-17,'});
  assert.equal(r3.findings.find(x=>x.key.startsWith('faiout')).sev,'warn');
  // project drawing revision differs from the FAI
  const r4=HQA.analyze({drawing:'',tests:'',meta:{mechNo:'DEMO-100-M',mechRev:'C'},faiH});assert.ok(codes(r4).includes('fairev'));
  // report contains the FAI section
  const html_=HQA.reportHtml({meta:{},res:r,reviews:{},date:'',reportNo:''});assert.ok(html_.includes('FAI לפי AS9102')&&html_.includes('מחוץ לתחום'));
});
test('FAI forms import from a PDF table with AS9102 headers ("8. Requirement")',()=>{
  const items=[];let y=700;
  ['5. Char. No.','6. Reference Location','7. Characteristic Designator','8. Requirement','9. Results','10. Designed / Qualified Tooling','11. Nonconformance Number','12. Additional Data / Comments'].forEach((h,i)=>items.push(item(h,40+i*200,y)));
  [['1','C2 – C4','LENGTH','280 MM + 5 MM','283 MM','METER','','2628-0001'],['1','C2 – C4','LENGTH','280 MM + 5 MM','284 MM','METER','','2628-0003']].forEach(r=>{y-=16;r.forEach((v,i)=>items.push(item(v,40+i*200,y)));});
  const tbl=HQA.tableFromLines(HQA.pdfLines(items));const {map}=HQA.autoMap(tbl,'fai3');
  assert.equal(JSON.stringify(map),JSON.stringify(['no','loc','char','req','result','tool','nc','comment']));
  const out=HQA.tableToCsv(tbl,map,'fai3',{});assert.equal(out.count,2);
  const r=HQA.analyze({drawing:'',tests:'',faiH:{faiType:'מלא'},fai3:out.csv});
  assert.equal(r.metrics.find(x=>x.key==='faiChar').covered,2);
  assert.ok(codes(r).includes('faifew'),'a full FAI with one characteristic');
  assert.ok(!codes(r).includes('faigaps'),'repeated number with different serials is not a gap');
});

console.log(`\n${pass} passed`);
