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
  assert.equal(metric(r,'wires').covered,0);
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
  for(const m of r2.metrics.filter(m=>m.key!=='mech'))assert.equal(m.covered,m.total,m.label);
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

console.log(`\n${pass} passed`);
