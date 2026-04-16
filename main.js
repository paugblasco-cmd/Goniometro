const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");

const screens = {
  start: document.getElementById("start-screen"),
  dashboard: document.getElementById("dashboard-screen"),
  mainMenu: document.getElementById("main-menu-screen"),
  form: document.getElementById("form-screen"),
  camera: document.getElementById("camera-screen"),
  physio: document.getElementById("physio-screen")
};

const sfxGood = document.getElementById("sfx-good");
const sfxLevel = document.getElementById("sfx-level");

let detector = null, running = false, animationFrameId = null;
let canvasW = 0, canvasH = 0, videoScale = 1, xOffset = 0, yOffset = 0;

let currentMode = 'frontal'; 
let activePatient = "";
let smoothedAngleL = null, smoothedAngleR = null;
let maxAngleAchievedL = 0, maxAngleAchievedR = 0;
let isHoldingL = false, isHoldingR = false;
let holdStartTimeL = 0, holdStartTimeR = 0;

// NUEVAS VARIABLES PARA REPETICIONES
let sessionReps = 0;
let lastRepTime = 0;

const DB = {
  load() { return JSON.parse(localStorage.getItem('gonioPatients') || '{}'); },
  save(data) { localStorage.setItem('gonioPatients', JSON.stringify(data)); },
  addRecord(name, mode, maxL, maxR) {
    const data = this.load();
    if (!data[name]) data[name] = [];
    const date = new Date().toLocaleString();
    data[name].unshift({ date, mode, maxL, maxR }); 
    this.save(data);
  },
  renderList() {
    const data = this.load();
    const list = document.getElementById("patient-list");
    list.innerHTML = "";
    Object.keys(data).forEach(name => {
      data[name].forEach(record => {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${name}</strong> 
                        <span>${record.mode === 'frontal' ? 'Frontal' : 'Lateral'}</span>
                        <span>Izq: ${record.maxL}° | Der: ${record.maxR}°</span>
                        <span style="color:#94a3b8; font-size:0.8em">${record.date}</span>`;
        list.appendChild(li);
      });
    });
  }
};

function playSfx(audio) { if (audio) { audio.currentTime = 0; audio.play().catch(()=>{}); } }

function updateDashboardNav() {
    const dashBackBtn = document.getElementById("dash-back-menu-btn");
    if(dashBackBtn) dashBackBtn.style.display = activePatient !== "" ? "block" : "none";
}

function showScreen(name) { 
  Object.values(screens).forEach(s => s.classList.remove("active")); 
  if (screens[name]) screens[name].classList.add("active"); 
  video.style.opacity = name === 'physio' ? "1" : "0.3";
  if(name === 'dashboard') updateDashboardNav();
}

async function initCamera() {
  const statusEl = document.getElementById("camera-status");
  statusEl.textContent = "Solicitando permisos de cámara...";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream; 
    await new Promise(res => video.onloadedmetadata = res);
    resizeCanvas(); 
    return true;
  } catch (err) { 
    statusEl.textContent = "Error: Cámara no accesible."; 
    statusEl.style.color = "#ef4444";
    return false; 
  }
}

function resizeCanvas() {
  const rect = video.getBoundingClientRect();
  canvasW = rect.width; canvasH = rect.height;
  overlay.width = canvasW * window.devicePixelRatio; 
  overlay.height = canvasH * window.devicePixelRatio;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  videoScale = Math.max(canvasW / video.videoWidth, canvasH / video.videoHeight);
  xOffset = (canvasW - video.videoWidth * videoScale) / 2; 
  yOffset = (canvasH - video.videoHeight * videoScale) / 2;
}
window.addEventListener("resize", resizeCanvas);

function mapCoords(p) {
  let x = p.x * videoScale + xOffset; 
  let y = p.y * videoScale + yOffset;
  x = canvasW - x; 
  return { ...p, x, y };
}

async function initDetector() {
  const statusEl = document.getElementById("camera-status");
  statusEl.textContent = "Cargando modelo de IA (MoveNet)... Por favor espera.";
  detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet, 
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
  );
}

function calculateAngle(p1, p2, p3) {
  const a = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
  const b = Math.sqrt(Math.pow(p2.x - p3.x, 2) + Math.pow(p2.y - p3.y, 2));
  const c = Math.sqrt(Math.pow(p3.x - p1.x, 2) + Math.pow(p3.y - p1.y, 2));
  return (Math.acos((a*a + b*b - c*c) / (2 * a * b)) * 180) / Math.PI;
}

function drawGoniometer(pt1, pt2, pt3, angle, holdProgress, colorTheme) {
  ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y); ctx.lineTo(pt2.x, pt2.y); ctx.lineTo(pt3.x, pt3.y); ctx.stroke();
  
  ctx.beginPath(); ctx.arc(pt2.x, pt2.y, 10, 0, Math.PI*2); 
  ctx.fillStyle = colorTheme; ctx.fill(); 
  ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
  
  if (holdProgress > 0) {
    ctx.beginPath(); 
    ctx.arc(pt2.x, pt2.y, 25, -Math.PI/2, (-Math.PI/2) + (holdProgress * Math.PI * 2));
    ctx.strokeStyle = "#10b981"; ctx.lineWidth = 6; ctx.stroke();
  }

  ctx.fillStyle = colorTheme; ctx.font = "800 24px sans-serif";
  ctx.shadowColor = "#000"; ctx.shadowBlur = 8;
  ctx.fillText(`${angle}°`, pt2.x + 20, pt2.y - 20);
  ctx.shadowBlur = 0;
}

// NUEVA FUNCIÓN: Lógica de 3 repeticiones y auto-salto
function registerRepCompleted() {
    if (performance.now() - lastRepTime < 2000) return; // Evita conteo doble si levanta ambos brazos a la vez
    lastRepTime = performance.now();
    
    sessionReps++;
    const repCounter = document.getElementById("rep-counter");
    if (repCounter) repCounter.textContent = `Repeticiones: ${sessionReps} / 3`;

    if (sessionReps >= 3) {
        // Auto-guardado
        DB.addRecord(activePatient, currentMode, Math.round(maxAngleAchievedL), Math.round(maxAngleAchievedR));
        playSfx(sfxGood);
        
        if (currentMode === 'frontal') {
            alert("✅ 3 Mediciones Frontales completadas.\nSe han guardado los datos. Cambiando a Modo Lateral.");
            document.getElementById("btn-lateral").click(); // Auto-clic al botón lateral
        } else {
            alert("✅ 3 Mediciones Laterales completadas.\nEvaluación Finalizada. Volviendo al historial.");
            document.getElementById("finish-btn").click(); // Auto-clic a finalizar
            setTimeout(() => {
                showScreen('dashboard'); // Forza la ida al historial
                DB.renderList();
            }, 500);
        }
    }
}

function processArm(hip, shoulder, elbow, isLeft) {
    if (!hip || !shoulder || !elbow || hip.score < 0.3 || shoulder.score < 0.3 || elbow.score < 0.3) {
        return { displayAngle: null, progress: 0 };
    }

    let rawAngle = calculateAngle(hip, shoulder, elbow);
    rawAngle = Math.max(0, 180 - rawAngle);
    rawAngle = Math.abs(180 - rawAngle); 
    
    let currentSmoothed = isLeft ? smoothedAngleL : smoothedAngleR;
    let currentMax = isLeft ? maxAngleAchievedL : maxAngleAchievedR;
    let isHolding = isLeft ? isHoldingL : isHoldingR;
    let holdStartTime = isLeft ? holdStartTimeL : holdStartTimeR;

    if (currentSmoothed === null) currentSmoothed = rawAngle;
    else currentSmoothed = (currentSmoothed * 0.85) + (rawAngle * 0.15); 
    
    let displayAngle = Math.round(currentSmoothed);
    
    if (displayAngle > currentMax) {
        currentMax = displayAngle;
    } else if (currentMax > displayAngle + 15) {
        currentMax -= 0.2; 
    }

    let holdProgress = 0;
    if (displayAngle > 45 && displayAngle >= currentMax - 10) {
        if (!isHolding) { 
            isHolding = true; holdStartTime = performance.now(); 
        } else {
            let duration = performance.now() - holdStartTime;
            holdProgress = Math.min(1, duration / 3000);
            if (duration >= 3000) { 
                playSfx(sfxLevel); 
                isHolding = false;
                holdStartTime = performance.now() + 2000;
                
                // INYECCIÓN DE LA NUEVA LÓGICA DE REPETICIONES
                registerRepCompleted();
            }
        }
    } else { 
        isHolding = false; holdStartTime = 0; 
    }

    if (isLeft) {
        smoothedAngleL = currentSmoothed; maxAngleAchievedL = currentMax;
        isHoldingL = isHolding; holdStartTimeL = holdStartTime;
        document.getElementById("current-angle-l").textContent = `${displayAngle}°`;
        document.getElementById("max-angle-l").textContent = `${Math.round(currentMax)}°`;
    } else {
        smoothedAngleR = currentSmoothed; maxAngleAchievedR = currentMax;
        isHoldingR = isHolding; holdStartTimeR = holdStartTime;
        document.getElementById("current-angle-r").textContent = `${displayAngle}°`;
        document.getElementById("max-angle-r").textContent = `${Math.round(currentMax)}°`;
    }

    return { displayAngle, progress: holdProgress };
}

function processClinicalData(pose) {
  const kp = pose.keypoints;
  const find = name => kp.find(k => k.name === name);

  const hipL = find("left_hip"), shoulderL = find("left_shoulder"), elbowL = find("left_elbow");
  const hipR = find("right_hip"), shoulderR = find("right_shoulder"), elbowR = find("right_elbow");

  if (currentMode === 'frontal') {
      const leftData = processArm(hipL, shoulderL, elbowL, true);
      const rightData = processArm(hipR, shoulderR, elbowR, false);

      if(leftData.displayAngle !== null) drawGoniometer(hipL, shoulderL, elbowL, leftData.displayAngle, leftData.progress, "#f43f5e"); 
      else document.getElementById("current-angle-l").textContent = "--";

      if(rightData.displayAngle !== null) drawGoniometer(hipR, shoulderR, elbowR, rightData.displayAngle, rightData.progress, "#38bdf8"); 
      else document.getElementById("current-angle-r").textContent = "--";

  } else if (currentMode === 'lateral') {
      const leftConf = (hipL?.score || 0) + (shoulderL?.score || 0) + (elbowL?.score || 0);
      const rightConf = (hipR?.score || 0) + (shoulderR?.score || 0) + (elbowR?.score || 0);
      
      const isLeftVisible = leftConf > rightConf;
      
      if (isLeftVisible) {
          const leftData = processArm(hipL, shoulderL, elbowL, true);
          if(leftData.displayAngle !== null) drawGoniometer(hipL, shoulderL, elbowL, leftData.displayAngle, leftData.progress, "#f43f5e");
          document.getElementById("current-angle-r").textContent = "-- (Oculto)";
      } else {
          const rightData = processArm(hipR, shoulderR, elbowR, false);
          if(rightData.displayAngle !== null) drawGoniometer(hipR, shoulderR, elbowR, rightData.displayAngle, rightData.progress, "#38bdf8");
          document.getElementById("current-angle-l").textContent = "-- (Oculto)";
      }
  }
}

async function renderLoop() {
  if (!running || !detector) return;
  const poses = await detector.estimatePoses(video, { flipHorizontal: false }); 
  ctx.clearRect(0, 0, canvasW, canvasH);
  if (poses && poses.length > 0) {
    const mappedPose = { ...poses[0], keypoints: poses[0].keypoints.map(mapCoords) };
    processClinicalData(mappedPose);
  }
  animationFrameId = requestAnimationFrame(renderLoop);
}

// EVENTOS DE NAVEGACIÓN Y UI
document.getElementById("start-btn").addEventListener("click", () => {
  DB.renderList();
  showScreen('dashboard');
});

document.getElementById("search-history").addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase();
    const items = document.querySelectorAll("#patient-list li");
    items.forEach(li => {
        const name = li.querySelector("strong").textContent.toLowerCase();
        li.style.display = name.includes(term) ? "flex" : "none";
    });
});

document.getElementById("new-session-btn").addEventListener("click", () => {
  const name = document.getElementById("patient-name").value.trim();
  if (name === "") { alert("Introduce el nombre del paciente"); return; }
  activePatient = name;
  document.getElementById("current-patient-name").textContent = name;
  
  document.getElementById("menu-patient-name").textContent = name;
  document.getElementById("form-patient-name").textContent = name;
  showScreen('mainMenu'); 
});

// NUEVO BOTÓN: Volver al menú desde el Dashboard (Historial)
document.getElementById("dash-back-menu-btn").addEventListener("click", () => {
    showScreen('mainMenu');
});

document.getElementById("menu-gonio-btn").addEventListener("click", () => {
    showScreen('camera');
});

document.getElementById("menu-history-btn").addEventListener("click", () => {
    DB.renderList();
    showScreen('dashboard');
});

document.getElementById("menu-form-btn").addEventListener("click", () => {
    showScreen('form');
});

document.getElementById("menu-exit-btn").addEventListener("click", () => {
    activePatient = "";
    document.getElementById("patient-name").value = "";
    showScreen('dashboard');
});

document.getElementById("back-to-menu-btn").addEventListener("click", () => {
    showScreen('mainMenu');
});

document.getElementById("camera-btn").addEventListener("click", async () => { 
  if (await initCamera()) { 
      await initDetector(); 
      showScreen('physio');
      resetAngles();
      running = true;
      renderLoop();
  } 
});

document.getElementById("save-data-btn").addEventListener("click", () => {
  DB.addRecord(activePatient, currentMode, Math.round(maxAngleAchievedL), Math.round(maxAngleAchievedR));
  playSfx(sfxGood);
  alert(`Datos de ${activePatient} guardados manualmente.`);
});

document.getElementById("finish-btn").addEventListener("click", () => {
  running = false;
  if (video.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop());
  }
  showScreen('mainMenu'); 
});

const modal = document.getElementById("settings-modal");
document.getElementById("settings-btn").addEventListener("click", () => modal.classList.remove("hidden"));
document.getElementById("close-settings-btn").addEventListener("click", () => modal.classList.add("hidden"));

const btnFrontal = document.getElementById("btn-frontal");
const btnLateral = document.getElementById("btn-lateral");
const modeLabel = document.getElementById("current-mode-label");

btnFrontal.addEventListener("click", () => {
    currentMode = 'frontal';
    btnFrontal.classList.replace('secondary', 'active');
    btnLateral.classList.replace('active', 'secondary');
    modeLabel.textContent = "Modo: Frontal (Bilateral)";
    resetAngles();
    modal.classList.add("hidden");
});

btnLateral.addEventListener("click", () => {
    currentMode = 'lateral';
    btnLateral.classList.replace('secondary', 'active');
    btnFrontal.classList.replace('active', 'secondary');
    modeLabel.textContent = "Modo: Lateral (Unilateral)";
    resetAngles();
    modal.classList.add("hidden");
});

function resetAngles() {
    smoothedAngleL = null; smoothedAngleR = null;
    maxAngleAchievedL = 0; maxAngleAchievedR = 0;
    sessionReps = 0; // Resetear contador al cambiar de modo
    document.getElementById("current-angle-l").textContent = "0°";
    document.getElementById("max-angle-l").textContent = "0°";
    document.getElementById("current-angle-r").textContent = "0°";
    document.getElementById("max-angle-r").textContent = "0°";
    const repCounter = document.getElementById("rep-counter");
    if(repCounter) repCounter.textContent = "Repeticiones: 0 / 3";
}

// NUEVO: HARD RESET - Destruye la memoria IA y devuelve a inicio
document.getElementById("reset-skeleton-btn").addEventListener("click", () => {
    modal.classList.add("hidden");
    
    // 1. Detener el bucle de renderizado
    running = false;
    
    // 2. Destruir la instancia del modelo de IA (Limpia memoria y errores de cache)
    if (detector) {
        detector.dispose(); 
        detector = null;
    }
    
    // 3. Apagar la cámara actual
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }
    
    // 4. Limpiar variables matemáticas
    resetAngles();
    
    // 5. Enviar a la pantalla de conexión para forzar reinicio limpio
    showScreen('camera');
    
    // Feedback visual para el usuario
    const statusEl = document.getElementById("camera-status");
    statusEl.textContent = "Sistema purgado. Por favor, vuelve a activar la cámara e IA.";
    statusEl.style.color = "#10b981"; // Color verde
    playSfx(sfxGood);
});