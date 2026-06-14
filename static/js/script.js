function retry() {
    window.location.href = "/scan";
}

document.addEventListener('DOMContentLoaded', function() {
    initializeFileUpload();
    initializeCameraCapture();
    initializePrivacyPopup();
    initializeResultSection();
});


function closePrivacyNotice() {
    /**
     * Hide the privacy notice popup
     */
    const popup = document.getElementById('privacy-popup');
    if (popup) {
        popup.style.display = 'none';
    }
}

function initializeFileUpload() {
    /**
     * Initialise file upload, find upload image link and hidden file input.
     * When the user clicks the link, preventDefault and programmatically trigger a click on the file input. Then, listen for
     * change events on that file input and call handleFileUpload().
     */
    const uploadLink = document.getElementById('upload-link');
    const fileInput = document.getElementById('fileUpload');
    
    if (uploadLink && fileInput) {
        console.log("Upload link found")
        uploadLink.addEventListener('click', e => {
            e.preventDefault();
            fileInput.click();
            console.log("Image has been selected")
        });
        fileInput.addEventListener("change", handleFileUpload);
    }
}

function handleFileUpload(e) {
    /**
     * Handle a change event from a file input. 
     * Validates that file is JPEG or PNG
     * If valid, it destroys the “scanning” UI, shows a loader, and sends the file to `/predict`
     * Store all prediction data in sessionStorage and redirect to result page
     */
    // Clear out any old prediction data
    sessionStorage.clear();
    const file = e.target.files[0]
    if (!file) return;

    if (!["image/jpeg", "image/png"].includes(file.type)) {
        alert("Please upload a JPEG or PNG image.");
        e.target.value = "";
        return;
    }

    //remove scan container & show loader in place
    document.querySelector(".face-scan-container")?.remove();
    document.getElementById("privacy-popup")?.remove();
    document.querySelectorAll('body > p').forEach(el => el.remove());
    document.getElementById("camera-button")?.remove();

    const loader = document.createElement("div")
    loader.className = "analyzing-container";
    loader.innerHTML = `
        <div class="loader"></div>
        <h1>AI analysing...</h1>
        <p>It will take some time...</p>`;
    document.body.appendChild(loader)

    const resetScanPage = () => {
        loader.remove();
        alert("Something went wrong during analysis. Please try again with a clear JPEG or PNG image.");
        window.location.href = "/scan";
    };

    const data = new FormData();
    data.append("file", file);

    // If the server returns an error, always remove the loader and send the user back to the scan page.
    fetch("/predict", {
        method: "POST",
        body: data
        })
        .then(async res => {
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
            // server‐sent JSON “error” field or a fallback
            throw new Error(payload.error || `${res.status} ${res.statusText}`);
            }
            return payload;
        })
        .then(json => {
            // stash & go to results
            sessionStorage.setItem("predictionResult",     json.result);
            sessionStorage.setItem("predictionConfidence", json.confidence);
            sessionStorage.setItem("votes",                JSON.stringify(json.votes));
            sessionStorage.setItem("confidences",          JSON.stringify(json.confidences));
            sessionStorage.setItem("notes",                JSON.stringify(json.notes));
            sessionStorage.setItem("featureLabels",       JSON.stringify(json.feature_labels)); // <<< NEW
            sessionStorage.setItem("boxes",                JSON.stringify(json.boxes));
            sessionStorage.setItem("uploadedFilename",     json.uploadedFilename || "capture.png");
            window.location.href = "/result";
        })
        .catch(err => {
            console.error("Prediction error:", err);
            const msg = err.message || "Something went wrong.";

            loader.remove();

            if (msg === "No face detected") {
                alert("No face detected. Please hold your face clearly in frame, ensure proper lighting and try again.");
                window.location.href = "/scan";
            } else if (msg.includes("Unsupported image format")) {
                alert("Unsupported image format. Please upload a JPEG or PNG image.");
                window.location.href = "/scan";
            } else if (msg.includes("Missing crop")) {
                alert("The app could not extract all facial regions from this image. Please try again with your face clearly visible and centred.");
                window.location.href = "/scan";
            } else {
                alert(msg);
                window.location.href = "/scan";
            }
        });

}

function initializeCameraCapture() {
    /**
     * Finds camera activation button. When clicked, this toggles betwene activate camera and capture from camera
     * On first click, it will show live video element
     * On second click, stop the stream and capture the image
     */
    const cameraButton = document.getElementById('camera-button');
    // camera activate & capture
    if (cameraButton) {
        const video = document.getElementById('camera-activate');
        const overlayText = document.getElementById('overlay-text');
        const canvas = document.getElementById('photo-canvas');
        let stream, isCameraActive = false;

        cameraButton.addEventListener('click', () => {
            if (!isCameraActive) {
                console.log("Activating camera ")
                navigator.mediaDevices.getUserMedia({video: true})
                .then(s => {
                    stream = s;
                    console.log("Camera stream received")
                    video.srcObject = s;
                    video.style.display = 'block';
                    overlayText.style.display = 'none';
                    isCameraActive = true;
                })
                .catch(err => {
                    console.error("Error accessing camera", err);
                    alert("Unable to access camera");
                })
            } else {
                console.log("Capturing image from video stream")
                const context = canvas.getContext('2d');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                context.drawImage(video, 0, 0, canvas.width, canvas.height);

                stream.getTracks().forEach(t => t.stop());
                console.log("Video stream stopped")

                // stop video stream
                video.style.display = 'none';
                canvas.style.display = 'none';
                cameraButton.style.display = 'none';
                overlayText.style.display  = "none";

                // Convert canvas to a File and call handleFileUpload
                canvas.toBlob(blob => {
                    console.log("Converted canvas to blob")
                    const file = new File([blob], "capture.png", { type: "image/png" });
                    handleFileUpload({ target: { files: [file] } });
                  }, "image/png");
            }
        })
    }
}

function initializePrivacyPopup() {
    /**
     * Wait 700ms then display privacy popup
     */
    const popup = document.getElementById('privacy-popup');
    if (!popup) return;

    setTimeout(() => {
        if (popup) {
            popup.style.display = 'flex';
        }
    }, 700);
}

function initializeResultSection() {
    /**
     * Reads prediction data from sessionStorage and populate the DOM
     *  1. Show healthy v sick message
     *  2. Build vote breakdown text (how many areas flagged)
     *  3. List each feature confidence percentage
     *  4. Render any advice notes 
     *  5. Draw bounding boxes + confidence score
     */
    const output     = document.getElementById("prediction-output");
    const votesBreak = document.getElementById("vote-breakdown");
    const ul         = document.getElementById("confidence-list");
    const adviceSec  = document.getElementById("advice-section");
    const notesList  = document.getElementById("notes-list");

    if (!output || !adviceSec || !notesList) {
        return;
    }

    const result    = sessionStorage.getItem("predictionResult");
    const votesStr  = sessionStorage.getItem("votes")       || "{}";
    const confsStr  = sessionStorage.getItem("confidences") || "{}";
    const notesStr  = sessionStorage.getItem("notes")       || "[]";

    // render final line
    if (result == "Healthy") {
        output.innerText = "You’re likely healthy!";
        output.classList.add("healthy");
    } else if (result == "Sick") {
        output.innerText = "You might be sick!";
        output.classList.add("sick");
    } else {
        output.innerText = "No prediction available.";
    }

    try {
    const votes = JSON.parse(votesStr);
    const total = votes.Sick + votes.Healthy;
    const flagged = votes.Sick;

    if (flagged === 0) {
        votesBreak.innerText = "All facial areas appear normal.";
    } else if (flagged <= total / 2) {
        votesBreak.innerText = 
        `Noticeable concerns in ${flagged} of ${total} areas — overall likely healthy.`;
    } else {
        votesBreak.innerText = 
        `Multiple areas (${flagged} of ${total}) showed potential issues — consider follow-up.`;
    }
    } catch (e) {
    console.warn("Could not parse votes:", e);
    }

    // per-feature confidences
    try {
      const confs = JSON.parse(confsStr);
      const prettyNames = {
        mouth:      "Mouth area",
        nose:       "Nose region",
        skin:       "Facial skin",
        left_eye:   "Left eye area",
        right_eye:  "Right eye area"
        };

        Object.entries(confs).forEach(([feature, score]) => {
            const li = document.createElement("li");
            const name = prettyNames[feature] || feature;
            const percent = (parseFloat(score) * 100).toFixed(1);
            li.innerHTML = `<strong>${name}</strong>: ${percent}% chance of concern`;
        ul.appendChild(li);
        });
    } catch (e) {
      console.warn("Could not parse confidences:", e);
    }

    let notes = [];
    try {
        const parsed = JSON.parse(notesStr);
        // only accept it if it really is an array
        if (Array.isArray(parsed)) {
            notes = parsed;
        }
    } catch (e) {
        console.warn("Could not parse notes, defaulting to empty:", e);
    }

    if (notes.length) {
        adviceSec.classList.remove("hidden");
        notes.forEach(txt => {
            const li = document.createElement("li");
            li.innerText = txt;
            notesList.appendChild(li);
        }) 
    }

    // ── debug log ──
    console.log("boxes:", JSON.parse(sessionStorage.getItem("boxes")||"{}"));
    console.log("labels:", JSON.parse(sessionStorage.getItem("featureLabels")||"{}"));

    // ── annotation ──
    const canvas = document.getElementById("annotation-canvas");
    if (!canvas) return;

    // pull boxes, labels, confidences
    const boxes  = JSON.parse(sessionStorage.getItem("boxes")        || "{}");
    const labels = JSON.parse(sessionStorage.getItem("featureLabels")|| "{}");
    const confs  = JSON.parse(sessionStorage.getItem("confidences")  || "{}");
    const filename = sessionStorage.getItem("uploadedFilename") || "capture.png";

    // map your short keys to full feature names
    const keyMap = { left: "left_eye", right: "right_eye" };

    const img = new Image();
    // add cache‐buster so browser always fetches the fresh file
    img.src = `/tmp/${filename}?_=${Date.now()}`;
    img.onload = () => {
    const ctx = canvas.getContext("2d");
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);

    ctx.lineWidth   = 4;
    ctx.strokeStyle = "red";
    ctx.font        = "20px sans-serif";
    ctx.fillStyle   = "red";

    Object.entries(boxes).forEach(([rawFeat, rect]) => {
      const feat = keyMap[rawFeat] || rawFeat;
      if (labels[feat] === "Sick") {
        const [x,y,w,h] = rect;
        const scoreText = parseFloat(confs[feat] || 0).toFixed(2);
        ctx.strokeRect(x, y, w, h);
        ctx.fillText(scoreText, x, y - 6);
      }
    });
  };
}
