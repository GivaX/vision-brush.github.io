'use strict';
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const calibrationCursor = $('calibration-cursor');
// WebGazer ridge keeps the last 50 click samples. Nine targets × five preserves every region.
const CALIBRATION_SAMPLES_PER_TARGET = 5;
const GAZE_EMA_TAU_SECONDS = 0.09;
const MOUSE_EMA_TAU_SECONDS = 0.04;
const TRACKING_GAP_MS = 250;
let input = 'mouse', filter = 'ema', strokes = [], stroke = null, armed = false, armAt = null;
let filtered = null, previousTime = null, lastValid = 0, recording = false, cameraReady = false;
let samples = [], validation = [], calibration = null, dwell = null, dwellStart = 0, latched = null, eyeReady = false;
const session = {id: crypto.randomUUID(), started: new Date().toISOString(), webgazerVersion:'3.5.3', gazeEmaTauSeconds: GAZE_EMA_TAU_SECONDS, events:[]};
const message = text => $('status').textContent = text;
const event = (type, detail={}) => session.events.push({t_ms:performance.now(), type, ...detail});
function stop() { armed=false; armAt=null; stroke=null; $('mode').textContent='Look mode · no ink'; }
function resetSignal() { filtered=null; previousTime=null; }
function smoothPosition(position, time, tau) {
  if (!filtered || time - previousTime > TRACKING_GAP_MS) {
    filtered = {x: position.x, y: position.y};
  } else {
    const dt = Math.max(.001, (time - previousTime) / 1000);
    const alpha = 1 - Math.exp(-dt / tau);
    filtered = {
      x: filtered.x + alpha * (position.x - filtered.x),
      y: filtered.y + alpha * (position.y - filtered.y),
    };
  }
  previousTime = time;
  return filtered;
}
function resize() {
  stop(); const rect=canvas.getBoundingClientRect();
  canvas.width=Math.round(rect.width*devicePixelRatio); canvas.height=Math.round(rect.height*devicePixelRatio);
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); render();
  if(cameraReady){message('Window changed. Recalibrate before gaze drawing.'); $('start').disabled=input==='gaze';}
  if(calibration) finishCalibration(true);
}
function render() {
  const r=canvas.getBoundingClientRect(); ctx.clearRect(0,0,r.width,r.height);
  ctx.lineWidth=3;ctx.strokeStyle='#21694f';ctx.lineCap='round';ctx.lineJoin='round';
  for(const points of strokes){if(!points.length)continue; ctx.beginPath();ctx.moveTo(points[0][0]*r.width,points[0][1]*r.height); for(const p of points)ctx.lineTo(p[0]*r.width,p[1]*r.height);ctx.stroke();}
}
function resetDwell(){if(dwell)dwell.style.removeProperty('--dwell');dwell=null;dwellStart=0;}
function gazeDwell(x,y,t){
  const button=document.elementFromPoint(x,y)?.closest('button[data-dwell]');
  if(button!==latched)latched=null;
  if(!button||button.disabled||button===latched){resetDwell();return;}
  if(button!==dwell){resetDwell();dwell=button;dwellStart=t;}
  const fraction=Math.min(1,(t-dwellStart)/1000);button.style.setProperty('--dwell',fraction);
  if(fraction===1){latched=button;resetDwell();button.click();}
}
function receive(data,t,source){
  if(source!==input)return;
  const valid=!!data&&Number.isFinite(data.x)&&Number.isFinite(data.y);
  if(recording)samples.push({t_ms:t,source,valid,x:valid?data.x:null,y:valid?data.y:null,pen:!!stroke,filter,viewport:[innerWidth,innerHeight],canvas:canvas.getBoundingClientRect().toJSON()});
  $('samples').textContent=`${samples.length} samples recorded`;
  if (calibration) {
    calibration.lastFrameAt = t;
    const prediction = valid ? data : null;
    showCalibrationCursor(prediction, t);
    collectCalibration(prediction, t);
    return;
  }
  if(!valid){stroke=null;resetSignal();resetDwell();$('cursor').hidden=true;return;}
  if(t-lastValid>TRACKING_GAP_MS){stroke=null;resetSignal();}
  lastValid=t;
  const tau = source === 'gaze' ? GAZE_EMA_TAU_SECONDS : MOUSE_EMA_TAU_SECONDS;
  const p = filter === 'raw' ? data : smoothPosition(data, t, tau);
  $('cursor').hidden=false;$('cursor').style.left=`${p.x}px`;$('cursor').style.top=`${p.y}px`;
  const rect=canvas.getBoundingClientRect(), inside=p.x>=rect.left&&p.x<=rect.right&&p.y>=rect.top&&p.y<=rect.bottom;
  if(!inside){if(stroke||armAt!==null)stop();}
  if(source==='gaze')gazeDwell(p.x,p.y,t);
  if(!armed||!inside)return;
  if(armAt===null){armAt=t;$('mode').textContent='Starting in 1 second…';}
  if(t-armAt<1000)return;
  if(!stroke){stroke=[];strokes.push(stroke);event('stroke_start');}
  stroke.push([(p.x-rect.left)/rect.width,(p.y-rect.top)/rect.height]);
  $('mode').textContent='Drawing · look into controls to stop';render();
}
document.addEventListener('pointermove',e=>receive({x:e.clientX,y:e.clientY},performance.now(),'mouse'));
$('start').onclick=()=>{stop();armed=true;event('arm');message('Look at your starting point on the canvas. Ink starts after one second.');};
$('stop').onclick=()=>{stop();event('stop');};
$('undo').onclick=()=>{stop();strokes.pop();render();event('undo');};
$('clear').onclick=()=>{stop();strokes=[];render();event('clear');};
for(const name of ['raw','ema'])$(name).onclick=()=>{stop();filter=name;resetSignal();$('raw').classList.toggle('selected',name==='raw');$('ema').classList.toggle('selected',name==='ema');event('filter',{filter});};
$('mouse').onclick=()=>{stop();input='mouse';resetSignal();$('start').disabled=false;$('mouse').classList.add('selected');message('Mouse practice: this tests drawing controls, not eye tracking.');};
$('record').onclick=()=>{recording=!recording;$('record').textContent=recording?'Stop recording':'Record session';event('recording',{recording});};
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').onclick=()=>download(new Blob([JSON.stringify({...session,validation,samples},null,2)],{type:'application/json'}),`visionbrush-${session.id}.json`);
$('save').onclick=()=>canvas.toBlob(blob=>download(blob,'visionbrush.png'));
async function loadWebgazer(){
  if(window.webgazer)return;
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/webgazer.js';script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Could not load WebGazer. Check your internet connection.'));};document.head.append(script);});
}
$('camera').onclick=async()=>{
  stop();$('camera').disabled=true;message('Loading gaze tracker. Your browser will request camera permission.');
  try{
    await loadWebgazer();
    if(!cameraReady){
      webgazer.params.faceMeshSolutionPath='https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619';
      webgazer.saveDataAcrossSessions(false).applyKalmanFilter(false).setGazeListener((data)=>receive(data,performance.now(),'gaze'));
      // Track successful eye extraction even before ridge regression has its first label.
      const tracker=webgazer.getTracker(), extract=tracker.getEyePatches.bind(tracker);
      tracker.getEyePatches=async(...args)=>{const eyes=await extract(...args);eyeReady=!!eyes;return eyes;};
      await webgazer.begin(); webgazer.removeMouseEventListeners();webgazer.showPredictionPoints(false);cameraReady=true;
    }
    input='gaze';resetSignal();$('mouse').classList.remove('selected');$('start').disabled=true;$('calibrate').disabled=false;
    $('camera').textContent='Use camera';message('Camera ready. Calibrate while looking at each target.');
  }catch(error){message(`Camera setup failed: ${error.message}`);}finally{$('camera').disabled=false;}
};
function targetPosition(){const p=calibration.targets[calibration.index];return{x:p[0]*innerWidth,y:p[1]*innerHeight};}
function showTarget() {
  const p = targetPosition();
  const training = calibration.phase === 'train';
  $('target').style.left = `${p.x}px`;
  $('target').style.top = `${p.y}px`;
  $('instructions').textContent = `${training ? 'Calibration' : 'Validation'} · target ${calibration.index + 1} of ${calibration.targets.length}`;
  $('calibration-feedback').textContent = training
    ? 'Look at the green dot. The purple ring shows the current gaze estimate.'
    : 'Look at the green dot while we measure tracking accuracy.';
  calibration.at = performance.now();
  calibration.points = [];
  calibration.count = 0;
  calibration.lastTraining = -Infinity;
  if (!training) calibrationCursor.hidden = true;
}
function showCalibrationCursor(prediction, t) {
  if (calibration.phase !== 'train' || !prediction) {
    calibrationCursor.hidden = true;
    resetSignal();
    return;
  }
  const position = smoothPosition(prediction, t, GAZE_EMA_TAU_SECONDS);
  // Keep the indicator visible at the edge when the estimated point is off-screen.
  const x = Math.max(0, Math.min(innerWidth, position.x));
  const y = Math.max(0, Math.min(innerHeight, position.y));
  calibrationCursor.style.left = `${x}px`;
  calibrationCursor.style.top = `${y}px`;
  calibrationCursor.hidden = false;
}
function collectCalibration(data, t) {
  if (t - calibration.at < 650) return;
  if (calibration.phase === 'validate') {
    if (data) calibration.points.push([data.x, data.y]);
    return;
  }
  // A prediction can be null until the first eye sample has a target label.
  if (!eyeReady || calibration.count >= CALIBRATION_SAMPLES_PER_TARGET ||
      t - calibration.lastTraining < 200) return;
  const p = targetPosition();
  webgazer.recordScreenPosition(p.x, p.y, 'click');
  calibration.count++;
  calibration.lastTraining = t;
}
function advanceCalibration(){
  if(!calibration)return;
  if(performance.now()-calibration.at<2000)return;
  if (calibration.phase === 'train' && calibration.count < CALIBRATION_SAMPLES_PER_TARGET) {
    if (performance.now() - calibration.at > 7000) {
      finishCalibration(true);
      message('Not enough eye samples. Adjust lighting and positioning, then retry.');
    }
    return;
  }
  if(calibration.phase==='validate'){
    const p=targetPosition(),points=calibration.points;
    const errors=points.map(q=>Math.hypot(q[0]-p.x,q[1]-p.y)).sort((a,b)=>a-b);
    const center=points.length?points.reduce((s,q)=>[s[0]+q[0]/points.length,s[1]+q[1]/points.length],[0,0]):null;
    validation.push({target:p,samples:points.length,median_error_px:errors.length?errors[Math.floor(errors.length*.5)]:null,p90_error_px:errors.length?errors[Math.min(errors.length-1,Math.floor(errors.length*.9))]:null,mean_error_px:center?Math.hypot(center[0]-p.x,center[1]-p.y):null,estimated_center_px:center?{x:center[0],y:center[1]}:null,spread_rms_px:center?Math.sqrt(points.reduce((s,q)=>s+(q[0]-center[0])**2+(q[1]-center[1])**2,0)/points.length):null,viewport:[innerWidth,innerHeight]});
  }
  calibration.index++;
  if(calibration.index===calibration.targets.length){
    if(calibration.phase==='train'){calibration.phase='validate';calibration.targets=[[.2,.25],[.7,.2],[.45,.45],[.25,.7],[.7,.75]];calibration.index=0;}
    else{finishCalibration(false);return;}
  }showTarget();
}
function finishCalibration(cancelled){calibration=null;$('overlay').hidden=true;calibrationCursor.hidden=true;resetSignal();stop();
  if(cancelled){$('start').disabled=true;message('Calibration cancelled or interrupted. Retry before gaze drawing.');return;}
  const usable=validation.filter(v=>v.samples>=10);$('start').disabled=usable.length!==5;
  const avg=usable.length?Math.round(usable.reduce((s,v)=>s+v.median_error_px,0)/usable.length):null;
  let verticalCheck = '';
  if (usable.length === 5) {
    const [upperLeft, upperRight, , lowerLeft, lowerRight] = validation;
    const targetSpan = (lowerLeft.target.y + lowerRight.target.y - upperLeft.target.y - upperRight.target.y) / 2;
    const estimatedSpan = (lowerLeft.estimated_center_px.y + lowerRight.estimated_center_px.y -
      upperLeft.estimated_center_px.y - upperRight.estimated_center_px.y) / 2;
    verticalCheck = ` Upper and lower targets were ${Math.round(targetSpan)} px apart vertically. The tracker moved ${Math.round(Math.abs(estimatedSpan))} px ${estimatedSpan >= 0 ? 'down' : 'up'}.`;
  }
  $('validation').textContent=`Validation: ${usable.length}/5 targets with ≥10 samples. Mean of target median errors: ${avg??'unavailable'} px.${verticalCheck}`;
  message(usable.length===5?'Validation recorded. Review the measured error before drawing.':'Insufficient validation samples. Recalibrate.');event('calibration_complete',{usable_targets:usable.length});
}
$('calibrate').onclick = () => {
  stop();
  resetSignal();
  input = 'gaze';
  validation = [];
  webgazer.clearData();
  webgazer.removeMouseEventListeners();
  calibration = {
    phase: 'train',
    targets: [[.5,.5],[.15,.15],[.85,.85],[.85,.15],[.15,.85],
      [.5,.15],[.5,.85],[.15,.5],[.85,.5]],
    index: 0,
    lastFrameAt: performance.now(),
  };
  $('overlay').hidden = false;
  $('cursor').hidden = true;
  calibrationCursor.hidden = true;
  showTarget();
};
$('cancel').onclick=()=>finishCalibration(true);
setInterval(() => {
  advanceCalibration();
  if (calibration && performance.now() - calibration.lastFrameAt > TRACKING_GAP_MS) {
    calibrationCursor.hidden = true;
  }
  if (input === 'gaze' && !calibration && performance.now() - lastValid > TRACKING_GAP_MS) {
    stroke = null;
    armAt = null;
    resetSignal();
    resetDwell();
    $('cursor').hidden = true;
    if (armed) $('mode').textContent = 'Tracking paused · waiting for eyes';
  }
}, 100);
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();resetDwell();if(calibration)finishCalibration(true);}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();if(calibration)finishCalibration(true);}});
window.addEventListener('resize',resize);resize();
