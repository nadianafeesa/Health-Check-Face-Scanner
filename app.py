from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import tensorflow as tf
import numpy as np
from PIL import Image
import glob, os
import matplotlib
matplotlib.use("Agg")
from augment.face_org import extractFace, faceCascade, detector, predictor, FACIAL_LANDMARKS_IDXS
from categorization.box_utils import get_face_boxes
from werkzeug.utils import secure_filename
from pathlib import Path
from augment.alter_images import increase_brightness
import cv2
PARSED_OUTPUT_DIR = Path(os.environ.get("PARSED_OUTPUT_DIR", "data/parsed"))


app = Flask(__name__, 
            static_folder='static',      # serves /static/*
            template_folder='templates') # renders templates/*.html
CORS(app)

# Facial features to vote on
face_features = ["mouth", "nose", "skin", "left_eye", "right_eye"]

best_models = {
    "left_eye": 8,
    "mouth": 5,
    "nose": 4, 
    "right_eye": 7,
    "skin": 4
}

# Load models for each region
models = {}
for feature in face_features:
    fold = best_models[feature]
    pattern = os.path.join("categorization", "model_saves", feature, f"model_{fold}.h5")
    candidates = glob.glob(pattern)
    if not candidates:
        raise FileNotFoundError(f"No models found for '{feature}', looked for {pattern}")

    # sort by the fold number and pick the highest
    candidates.sort(key=lambda p: int(os.path.basename(p).split("_")[1].split(".")[0]))
    best_checkpoint = candidates[-1]

    print(f"[INFO] Loading {feature} model from → {best_checkpoint}")
    models[feature] = tf.keras.models.load_model(best_checkpoint, compile=False)

#web pages
@app.route("/")
def home():
    return render_template("index.html")

@app.route("/scan")
def scan():
    return render_template("face-scanningpage.html")

@app.route("/analyse")
def analyse():
    return render_template("analysing-page.html")

@app.route("/result")
def result():
    return render_template("results-page.html")

def preprocess_array(arr, size=128):
    """Resize a NumPy array and scale to [0,1]."""
    img = Image.fromarray(arr).convert("RGB").resize((size, size))
    return np.expand_dims(np.array(img)/255.0, axis=0)

@app.route("/predict", methods=["POST"])
def predict():
    if 'file' not in request.files:
        return jsonify({'error': 'No image uploaded'}), 400
    
    upload = request.files['file']

    # 1) force a single fixed filename for every incoming image
    stem     = "capture"
    fname = f"{stem}.png"

    # 2) save it into the configured parsed tmp directory
    tmpdir  = PARSED_OUTPUT_DIR / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    on_disk = tmpdir / fname
    upload.save(on_disk)
    img = cv2.imread(str(on_disk))
    if img is None:
        return jsonify(error="Unsupported image format; please upload a JPEG or PNG"), 400
    
    # force all uploads into a standard max dimension
    img = cv2.imread(str(on_disk))
    h, w = img.shape[:2]
    max_dim = 640
    if max(h, w) > max_dim:
        scale = max_dim / float(max(h, w))
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(on_disk), img)

    app.logger.info(f"→ Saved upload to: {on_disk}")


    # compute feature boxes for results pages ──
    try:
        boxes = get_face_boxes(str(on_disk))
    except Exception as e:
        # tell the client “No face detected” so it can pop up & redirect
        return jsonify(error="No face detected"), 400

    print("→ Saved upload to:", on_disk)
    print("→ tmpdir contents:", list(tmpdir.iterdir()))

    img = cv2.imread(str(on_disk))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    # img = adjust_gamma(img, gamma = 0.8)
    img = increase_brightness(img, value=10)
    # img = gaussian_blur(img, 3)

    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    cv2.imwrite(str(on_disk), img)

    # 2) run your face-cropper
    cropped = extractFace(
        str(on_disk),
        status="tmp",
        file_name=stem,
        faceCascade=faceCascade,
        predictor=predictor,
        detector=detector
    )
    print("→ extractFace returned:", cropped)

    if cropped is None:
        return jsonify(error="No face detected"), 400

    # 3) make sure all five crops are there
    print("→ looking for crops:")
    for feat in face_features:
        p = tmpdir / f"{stem}_{feat}.png"
        print(f"    {feat:10s} -> exists={p.exists()} ({p.name})")
        if not p.exists():
            return jsonify(error=f"Missing crop for {feat}"), 500


    votes = []
    confidence_scores = {}
    thresholds = {
        "mouth": 0.6,
        "nose": 0.5,
        "skin": 0.7,
        "left_eye": 0.5,
        "right_eye": 0.5
    }

    feature_notes = {
        "left_eye": (
            "Your left eye may show signs of fatigue or irritation. "
            "Consider getting enough rest or checking for allergies or dryness."
        ),
        "right_eye": (
            "Your right eye may appear irritated or tired. "
            "This can be caused by lack of sleep, eye strain, or mild infections like conjunctivitis."
        ),
        "nose": (
            "Your nose region may show symptoms of congestion or sinus pressure. "
            "This could relate to a cold, flu, or sinusitis — especially if you're also experiencing headaches or fatigue."
        ),
        "mouth": (
            "Your mouth area may show signs of irritation. "
            "Swelling, or dryness could be caused by allergies or dehydration."
        ),
        "skin": (
            "Your skin seems to show unusual texture or color. "
            "This could be due to stress, acne, or skin conditions like eczema or rosacea."
        )
    }

    for feat in face_features:
        p = tmpdir / f"{stem}_{feat}.png"
        print(f"    {feat:10s} -> {p.exists()}  ({p})")
        crop = tmpdir / f"{stem}_{feat}.png"
        if not crop.exists():
            return jsonify(error=f"Missing crop for {feat}"), 500

        arr = np.array(Image.open(str(crop)))
        x   = preprocess_array(arr)
        #here, p is the prediction (float 0 to 1). 
        #predict() is the method to run data through the model
        p   = float(models[feat].predict(x)[0][0])
        threshold = thresholds.get(feat, 0.5)
        label = "Sick" if p > threshold else "Healthy"

        votes.append(label)
        confidence_scores[feat] = p


    sick_votes = votes.count("Sick")
    healthy_votes = votes.count("Healthy")
    final_result = "Sick" if sick_votes > healthy_votes else "Healthy"

    recommendations = []

    # DEBUG: show what each “doctor” said and the final tally
    print("=== VOTING DEBUG ===")
    for feature, score in confidence_scores.items():
        threshold = thresholds.get(feature, 0.5)
        vote = "Sick" if score != "Error" and score > threshold else "Healthy"
        if isinstance(score, float) and score > thresholds[feature]:
            if feature in feature_notes:
                recommendations.append(feature_notes[feature])
        print(f" - {feature}: prob={score} → vote={vote}")
    print(f" Sick votes: {sick_votes}, Healthy votes: {healthy_votes}")
    print(f" FINAL result: {final_result}")
    print("====================")

    # Convert boxes (and any other numpy scalars) to plain Python types
    serializable_boxes = {
        feat: [int(x), int(y), int(w), int(h)]
        for feat, (x, y, w, h) in boxes.items()
    }

    feature_labels = {}
    for feat, score in confidence_scores.items():
        # same logic you used before to assign label
        thresh = thresholds.get(feat, 0.5)
        feature_labels[feat] = "Sick" if score > thresh else "Healthy"

    return jsonify({
        "result": final_result,
        "votes": {
            "Sick": sick_votes,
            "Healthy": healthy_votes
        },
        "feature_labels": feature_labels, 
        "confidences": confidence_scores,
        "notes": recommendations,
        "boxes": serializable_boxes,
        "uploadedFilename": fname 

    })



@app.route("/tmp/<path:filename>")
def tmp_file(filename):
    # Serves files from the configured parsed tmp directory
    return send_from_directory(PARSED_OUTPUT_DIR / "tmp", filename)


if __name__ == "__main__":
    app.run(debug=True)
