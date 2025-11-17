// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// DOM elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const statusMessage = document.getElementById('statusMessage');
const errorMessage = document.getElementById('errorMessage');
const results = document.getElementById('results');

// Options
const extractTextCheckbox = document.getElementById('extractText');
const addPageNumbersCheckbox = document.getElementById('addPageNumbers');
const extractImagesCheckbox = document.getElementById('extractImages');

let selectedFile = null;
let extractedData = {
    text: '',
    images: []
};

// Drag and drop handlers
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type === 'application/pdf') {
        handleFileSelect(files[0]);
    } else {
        showError('Please drop a valid PDF file');
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

function handleFileSelect(file) {
    selectedFile = file;
    processBtn.disabled = false;
    processBtn.textContent = `Process ${file.name}`;
    errorMessage.style.display = 'none';
    results.style.display = 'none';
}

processBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    const shouldExtractText = extractTextCheckbox.checked;
    const shouldAddPageNumbers = addPageNumbersCheckbox.checked;
    const shouldExtractImages = extractImagesCheckbox.checked;

    if (!shouldExtractText && !shouldExtractImages) {
        showError('Please select at least one extraction option');
        return;
    }

    processBtn.disabled = true;
    progressContainer.style.display = 'block';
    results.style.display = 'none';
    errorMessage.style.display = 'none';
    extractedData = { text: '', images: [] };

    try {
        await processPDF(selectedFile, shouldExtractText, shouldAddPageNumbers, shouldExtractImages);
        displayResults();
    } catch (error) {
        showError(`Error processing PDF: ${error.message}`);
        console.error(error);
    } finally {
        processBtn.disabled = false;
        progressContainer.style.display = 'none';
    }
});

async function processPDF(file, extractText, addPageNumbers, extractImages) {
    updateProgress(0, 'Loading PDF...');

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    updateProgress(10, `Processing ${totalPages} pages...`);

    let markdownText = '';
    let allImages = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const progress = 10 + (pageNum / totalPages) * 80;
        updateProgress(progress, `Processing page ${pageNum} of ${totalPages}...`);

        // Extract text
        if (extractText) {
            const textContent = await page.getTextContent();
            let pageText = textContent.items.map(item => item.str).join(' ');

            // Clean up extra spaces
            pageText = pageText.replace(/\s+/g, ' ').trim();

            if (pageText) {
                if (addPageNumbers) {
                    markdownText += `\n\n## Page ${pageNum}\n\n`;
                }
                markdownText += pageText + '\n';
            }
        }

        // Extract images
        if (extractImages) {
            const images = await extractImagesFromPage(page, pageNum);
            allImages = allImages.concat(images);
        }
    }

    extractedData.text = markdownText.trim();
    extractedData.images = allImages;

    updateProgress(100, 'Complete!');
}

async function extractImagesFromPage(page, pageNum) {
    const images = [];
    const ops = await page.getOperatorList();

    for (let i = 0; i < ops.fnArray.length; i++) {
        // Check for all image paint operations
        if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject ||
            ops.fnArray[i] === pdfjsLib.OPS.paintJpegXObject ||
            ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject ||
            ops.fnArray[i] === pdfjsLib.OPS.paintImageMaskXObject) {

            const imageName = ops.argsArray[i][0];

            try {
                const image = await page.objs.get(imageName);

                if (image && image.width && image.height) {
                    // Skip very small images (likely artifacts or decorative elements)
                    if (image.width < 10 || image.height < 10) {
                        continue;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });

                    const imageData = ctx.createImageData(image.width, image.height);
                    let imageProcessed = false;

                    // Handle different image data formats based on kind
                    if (image.data) {
                        const data = image.data;
                        const kind = image.kind; // ImageKind: 1=Grayscale, 2=RGB, 3=RGBA

                        if (kind === 1) {
                            // Grayscale (1 byte per pixel)
                            for (let j = 0; j < data.length; j++) {
                                const offset = j * 4;
                                const gray = data[j];
                                imageData.data[offset] = gray;
                                imageData.data[offset + 1] = gray;
                                imageData.data[offset + 2] = gray;
                                imageData.data[offset + 3] = 255;
                            }
                            imageProcessed = true;
                        } else if (kind === 2) {
                            // RGB (3 bytes per pixel)
                            for (let j = 0; j < data.length; j += 3) {
                                const offset = (j / 3) * 4;
                                imageData.data[offset] = data[j];
                                imageData.data[offset + 1] = data[j + 1];
                                imageData.data[offset + 2] = data[j + 2];
                                imageData.data[offset + 3] = 255;
                            }
                            imageProcessed = true;
                        } else if (kind === 3) {
                            // RGBA (4 bytes per pixel)
                            imageData.data.set(data);
                            imageProcessed = true;
                        } else {
                            // Unknown format, try to auto-detect
                            const bytesPerPixel = Math.floor(data.length / (image.width * image.height));
                            if (bytesPerPixel === 1) {
                                // Likely grayscale
                                for (let j = 0; j < data.length; j++) {
                                    const offset = j * 4;
                                    const gray = data[j];
                                    imageData.data[offset] = gray;
                                    imageData.data[offset + 1] = gray;
                                    imageData.data[offset + 2] = gray;
                                    imageData.data[offset + 3] = 255;
                                }
                                imageProcessed = true;
                            } else if (bytesPerPixel === 3) {
                                // Likely RGB
                                for (let j = 0; j < data.length; j += 3) {
                                    const offset = (j / 3) * 4;
                                    imageData.data[offset] = data[j];
                                    imageData.data[offset + 1] = data[j + 1];
                                    imageData.data[offset + 2] = data[j + 2];
                                    imageData.data[offset + 3] = 255;
                                }
                                imageProcessed = true;
                            } else if (bytesPerPixel === 4) {
                                // Likely RGBA
                                imageData.data.set(data);
                                imageProcessed = true;
                            }
                        }
                    } else if (image.bitmap) {
                        // Bitmap data is already in RGBA format
                        imageData.data.set(image.bitmap);
                        imageProcessed = true;
                    }

                    if (imageProcessed) {
                        ctx.putImageData(imageData, 0, 0);

                        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                        if (blob && blob.size > 0) {
                            const url = URL.createObjectURL(blob);

                            images.push({
                                name: `page-${pageNum}-image-${images.length + 1}.png`,
                                url: url,
                                blob: blob,
                                width: image.width,
                                height: image.height
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn(`Could not extract image ${imageName} from page ${pageNum}:`, err);
            }
        }
    }

    return images;
}

function updateProgress(percent, message) {
    progressFill.style.width = `${percent}%`;
    progressFill.textContent = `${Math.round(percent)}%`;
    statusMessage.textContent = message;
}

function displayResults() {
    results.innerHTML = '';
    results.style.display = 'block';

    let hasResults = false;

    // Display markdown text result
    if (extractedData.text) {
        hasResults = true;
        const textResult = document.createElement('div');
        textResult.className = 'result-item';
        textResult.innerHTML = `
            <div class="result-info">
                <div class="result-title">📝 Extracted Text (Markdown)</div>
                <div class="result-meta">${extractedData.text.length} characters</div>
            </div>
            <button class="download-btn" onclick="downloadMarkdown()">Download</button>
        `;
        results.appendChild(textResult);
    }

    // Display images result
    if (extractedData.images.length > 0) {
        hasResults = true;
        const imagesResult = document.createElement('div');
        imagesResult.className = 'result-item';
        imagesResult.style.flexDirection = 'column';
        imagesResult.style.alignItems = 'stretch';

        const headerDiv = document.createElement('div');
        headerDiv.style.display = 'flex';
        headerDiv.style.justifyContent = 'space-between';
        headerDiv.style.alignItems = 'center';
        headerDiv.style.marginBottom = '15px';

        headerDiv.innerHTML = `
            <div class="result-info">
                <div class="result-title">🖼️ Extracted Images</div>
                <div class="result-meta">${extractedData.images.length} images found</div>
            </div>
            <button class="download-btn" onclick="downloadAllImages()">Download All</button>
        `;

        imagesResult.appendChild(headerDiv);

        const imagePreview = document.createElement('div');
        imagePreview.className = 'image-preview';

        extractedData.images.forEach((img, index) => {
            const imgElement = document.createElement('img');
            imgElement.src = img.url;
            imgElement.alt = img.name;
            imgElement.title = `${img.name} (${img.width}x${img.height})`;
            imgElement.style.cursor = 'pointer';
            imgElement.onclick = () => downloadImage(img, index);
            imagePreview.appendChild(imgElement);
        });

        imagesResult.appendChild(imagePreview);
        results.appendChild(imagesResult);
    }

    if (!hasResults) {
        results.innerHTML = '<div class="result-item"><div class="result-info"><div class="result-title">No content extracted</div><div class="result-meta">The PDF may not contain extractable text or images</div></div></div>';
    }
}

function downloadMarkdown() {
    const blob = new Blob([extractedData.text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedFile.name.replace('.pdf', '.md');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadImage(img, index) {
    const a = document.createElement('a');
    a.href = img.url;
    a.download = img.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function downloadAllImages() {
    if (extractedData.images.length === 0) return;

    // Create a new JSZip instance
    const zip = new JSZip();
    const imgFolder = zip.folder("images");

    // Add each image to the zip
    for (const img of extractedData.images) {
        imgFolder.file(img.name, img.blob);
    }

    // Generate the zip file
    try {
        const content = await zip.generateAsync({ type: "blob" });

        // Download the zip file
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = selectedFile.name.replace('.pdf', '_images.zip');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        showError('Failed to create zip file: ' + err.message);
    }
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    setTimeout(() => {
        errorMessage.style.display = 'none';
    }, 5000);
}
