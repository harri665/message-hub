import QtQuick

// Small line icons drawn once into a texture (no icon theme or SVG module needed).
Canvas {
    id: g
    property string name: "search"
    property color color: "white"
    property real stroke: 1.6
    width: 16
    height: 16
    onNameChanged: requestPaint()
    onColorChanged: requestPaint()
    onWidthChanged: requestPaint()
    onPaint: {
        const ctx = getContext("2d");
        const w = width, h = height;
        ctx.reset();
        ctx.strokeStyle = g.color;
        ctx.fillStyle = g.color;
        ctx.lineWidth = g.stroke;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        switch (g.name) {
        case "search":
            ctx.arc(w * 0.43, h * 0.43, w * 0.29, 0, Math.PI * 2);
            ctx.moveTo(w * 0.65, h * 0.65); ctx.lineTo(w * 0.88, h * 0.88);
            ctx.stroke();
            break;
        case "clear":
            ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = "destination-out";
            ctx.beginPath();
            ctx.lineWidth = 1.4;
            ctx.moveTo(w * 0.34, h * 0.34); ctx.lineTo(w * 0.66, h * 0.66);
            ctx.moveTo(w * 0.66, h * 0.34); ctx.lineTo(w * 0.34, h * 0.66);
            ctx.stroke();
            break;
        case "plus":
            ctx.moveTo(w / 2, h * 0.2); ctx.lineTo(w / 2, h * 0.8);
            ctx.moveTo(w * 0.2, h / 2); ctx.lineTo(w * 0.8, h / 2);
            ctx.stroke();
            break;
        case "up":
            ctx.moveTo(w / 2, h * 0.8); ctx.lineTo(w / 2, h * 0.22);
            ctx.moveTo(w * 0.24, h * 0.46); ctx.lineTo(w / 2, h * 0.2); ctx.lineTo(w * 0.76, h * 0.46);
            ctx.stroke();
            break;
        case "file":
            ctx.moveTo(w * 0.24, h * 0.1); ctx.lineTo(w * 0.6, h * 0.1); ctx.lineTo(w * 0.8, h * 0.3);
            ctx.lineTo(w * 0.8, h * 0.9); ctx.lineTo(w * 0.24, h * 0.9); ctx.closePath();
            ctx.moveTo(w * 0.6, h * 0.1); ctx.lineTo(w * 0.6, h * 0.3); ctx.lineTo(w * 0.8, h * 0.3);
            ctx.stroke();
            break;
        case "photo":
            ctx.rect(w * 0.1, h * 0.2, w * 0.8, h * 0.6);
            ctx.moveTo(w * 0.16, h * 0.72); ctx.lineTo(w * 0.4, h * 0.46); ctx.lineTo(w * 0.58, h * 0.64);
            ctx.lineTo(w * 0.68, h * 0.54); ctx.lineTo(w * 0.86, h * 0.72);
            ctx.stroke();
            break;
        case "reply":
            ctx.moveTo(w * 0.4, h * 0.22); ctx.lineTo(w * 0.14, h * 0.48); ctx.lineTo(w * 0.4, h * 0.74);
            ctx.moveTo(w * 0.14, h * 0.48); ctx.quadraticCurveTo(w * 0.86, h * 0.4, w * 0.86, h * 0.82);
            ctx.stroke();
            break;
        case "check":
            ctx.moveTo(w * 0.12, h * 0.54); ctx.lineTo(w * 0.4, h * 0.82); ctx.lineTo(w * 0.9, h * 0.18);
            ctx.stroke();
            break;
        case "muted": {
            // a bell with a slash through it
            ctx.moveTo(w * 0.5, h * 0.12);
            ctx.bezierCurveTo(w * 0.29, h * 0.12, w * 0.25, h * 0.3, w * 0.25, h * 0.46);
            ctx.lineTo(w * 0.25, h * 0.6); ctx.lineTo(w * 0.14, h * 0.74); ctx.lineTo(w * 0.86, h * 0.74);
            ctx.lineTo(w * 0.75, h * 0.6); ctx.lineTo(w * 0.75, h * 0.46);
            ctx.bezierCurveTo(w * 0.75, h * 0.3, w * 0.71, h * 0.12, w * 0.5, h * 0.12);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.arc(w * 0.5, h * 0.8, w * 0.1, 0, Math.PI);
            ctx.fill();
            // cut a gap around the slash so it reads against the bell, then draw it
            ctx.globalCompositeOperation = "destination-out";
            ctx.beginPath();
            ctx.lineWidth = g.stroke * 2.6;
            ctx.moveTo(w * 0.1, h * 0.08); ctx.lineTo(w * 0.9, h * 0.92);
            ctx.stroke();
            ctx.globalCompositeOperation = "source-over";
            ctx.beginPath();
            ctx.lineWidth = g.stroke;
            ctx.moveTo(w * 0.1, h * 0.08); ctx.lineTo(w * 0.9, h * 0.92);
            ctx.stroke();
            break;
        }
        case "pin": {
            // a pushpin, head up, point down-left
            ctx.moveTo(w * 0.34, h * 0.1); ctx.lineTo(w * 0.72, h * 0.1);
            ctx.lineTo(w * 0.66, h * 0.2); ctx.lineTo(w * 0.66, h * 0.42);
            ctx.lineTo(w * 0.8, h * 0.58); ctx.lineTo(w * 0.2, h * 0.58);
            ctx.lineTo(w * 0.34, h * 0.42); ctx.lineTo(w * 0.34, h * 0.2);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(w * 0.5, h * 0.58); ctx.lineTo(w * 0.5, h * 0.92);
            ctx.stroke();
            break;
        }
        case "archive": {
            // a lidded box
            ctx.rect(w * 0.1, h * 0.16, w * 0.8, h * 0.22);
            ctx.moveTo(w * 0.18, h * 0.38); ctx.lineTo(w * 0.18, h * 0.84); ctx.lineTo(w * 0.82, h * 0.84); ctx.lineTo(w * 0.82, h * 0.38);
            ctx.moveTo(w * 0.4, h * 0.56); ctx.lineTo(w * 0.6, h * 0.56);
            ctx.stroke();
            break;
        }
        case "back":
            ctx.moveTo(w * 0.62, h * 0.18); ctx.lineTo(w * 0.3, h * 0.5); ctx.lineTo(w * 0.62, h * 0.82);
            ctx.stroke();
            break;
        case "gear": {
            // a filled cog with eight teeth and a round hole
            const cx = w / 2, cy = h / 2, ro = w * 0.5, ri = w * 0.37, n = 8;
            for (let i = 0; i < n * 4; ++i) {
                const a = (i / (n * 4)) * Math.PI * 2 - Math.PI / 2;
                const r = (i % 4 === 1 || i % 4 === 2) ? ro : ri;
                if (i === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
                else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
            }
            ctx.closePath();
            ctx.fill();
            ctx.globalCompositeOperation = "destination-out";
            ctx.beginPath();
            ctx.arc(cx, cy, w * 0.17, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
        }
    }
}
