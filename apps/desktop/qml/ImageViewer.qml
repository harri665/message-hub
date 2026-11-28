pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Window
import MessageHub

// The in-app photo viewer: the photo large over a dimmed window. Esc or a click on the dim area closes it, the arrow
// keys (or the arrows on screen) step through the other photos of the chat, scrolling or pinching zooms, dragging pans a
// zoomed photo, a double click toggles between fit and 100%.
FocusScope {
    id: v
    objectName: "imageViewer"
    anchors.fill: parent
    visible: opacity > 0
    opacity: shown ? 1 : 0
    z: 90  // under the window buttons (z 101) and the context menu (z 1000)
    Behavior on opacity { NumberAnimation { duration: 140 } }

    property bool shown: false
    property var items: []   // [{ id, filename, mime, width, height }], oldest first
    property int index: -1
    readonly property var item: index >= 0 && index < items.length ? items[index] : null
    signal closed()

    readonly property real dpr: Screen.devicePixelRatio
    readonly property bool isGif: item && item.mime === "image/gif"

    // ---- what is shown ----
    // The picture's size in pixels: the full-size copy once loaded, else the small one that is already on screen in the
    // chat, else what the hub reported. Zoom 1 is 100% (one picture pixel per screen pixel).
    readonly property size natPx: full.status === Image.Ready ? Qt.size(full.implicitWidth, full.implicitHeight)
        : anim.status === Image.Ready ? Qt.size(anim.implicitWidth, anim.implicitHeight)
        : thumb.status === Image.Ready ? Qt.size(thumb.implicitWidth, thumb.implicitHeight)
        : item && item.width > 0 && item.height > 0 ? Qt.size(item.width, item.height) : Qt.size(0, 0)
    // Reference size (the thumbnail and the full copy differ in pixels but not in shape): the full copy's real pixels.
    property real fullW: 0
    property real fullH: 0
    readonly property real aspect: natPx.height > 0 ? natPx.width / natPx.height : 1
    readonly property real areaW: Math.max(50, width - 120)
    readonly property real areaH: Math.max(50, height - 150)
    // Zoom (1 = 100%). Until the user zooms, the photo fits the window.
    readonly property real logicalW: (fullW > 0 ? fullW : Math.max(natPx.width, 1)) / dpr
    readonly property real logicalH: logicalW / aspect
    readonly property real fitZoom: Math.min(areaW / logicalW, areaH / logicalH, 3)
    property real userZoom: 0
    readonly property real zoom: userZoom > 0 ? userZoom : fitZoom
    readonly property real maxZoom: Math.max(8, fitZoom * 2)
    property real panX: 0
    property real panY: 0
    readonly property real drawW: logicalW * zoom
    readonly property real drawH: logicalH * zoom

    function open(id) {
        const list = [];
        const m = Hub.messages;
        for (let i = m.count - 1; i >= 0; --i) {  // the model runs newest first
            for (const a of (m.get(i).attachments || []))
                if ((a.mime || "").startsWith("image/")) list.push({ id: a.id, filename: a.filename || "", mime: a.mime || "", width: a.width || 0, height: a.height || 0 });
        }
        const at = list.findIndex(a => Number(a.id) === Number(id));
        if (at < 0) return;
        items = list;
        show(at);
        shown = true;
        v.forceActiveFocus();
    }
    function show(i) {
        if (i < 0 || i >= items.length) return;
        index = i;
        resetView();
        fullW = 0;
        fullH = 0;
        if (isGif) Hub.fetchOriginal(item.id);
        else animSource = "";
    }
    function resetView() { userZoom = 0; panX = 0; panY = 0; }
    function step(d) { show(index + d); }
    function close() {
        if (!shown) return;
        shown = false;
        closed();
    }
    function clampPan() {
        const mx = Math.max(0, (drawW - stage.width) / 2), my = Math.max(0, (drawH - stage.height) / 2);
        panX = Math.max(-mx, Math.min(mx, panX));
        panY = Math.max(-my, Math.min(my, panY));
    }
    // Zoom so that the picture point under (px, py) (in the stage) stays there.
    function zoomAt(z, px, py) {
        const nz = Math.max(Math.min(fitZoom, 1), Math.min(maxZoom, z));
        const f = nz / zoom;
        const rx = px - stage.width / 2 - panX, ry = py - stage.height / 2 - panY;
        userZoom = nz;
        panX = px - stage.width / 2 - rx * f;
        panY = py - stage.height / 2 - ry * f;
        clampPan();
    }
    function toggleZoom(px, py) {
        const atFit = userZoom <= 0 || Math.abs(zoom - fitZoom) < 0.01;
        if (atFit) zoomAt(fitZoom < 0.98 ? 1 : fitZoom * 2, px, py);
        else resetView();
    }
    onDrawWChanged: clampPan()
    onDrawHChanged: clampPan()

    property string animSource: ""
    Connections {
        target: Hub
        function onOriginalReady(id, url) { if (v.item && Number(id) === Number(v.item.id)) v.animSource = url; }
    }

    Keys.onPressed: event => {
        event.accepted = true;
        if (event.key === Qt.Key_Escape) v.close();
        else if (event.key === Qt.Key_Left) v.step(-1);
        else if (event.key === Qt.Key_Right) v.step(1);
        else if (event.key === Qt.Key_Plus || event.key === Qt.Key_Equal) v.zoomAt(v.zoom * 1.25, stage.width / 2, stage.height / 2);
        else if (event.key === Qt.Key_Minus) v.zoomAt(v.zoom / 1.25, stage.width / 2, stage.height / 2);
        else if (event.key === Qt.Key_0) v.resetView();
        else event.accepted = false;
    }

    // Dimmed window. A click anywhere outside the photo closes the viewer.
    Rectangle { anchors.fill: parent; color: Qt.rgba(0, 0, 0, 0.9); radius: Platform.windowRadius }
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onClicked: mouse => {
            const px = mouse.x - stage.x, py = mouse.y - stage.y;
            const cx = stage.width / 2 + v.panX, cy = stage.height / 2 + v.panY;
            const inside = Math.abs(px - cx) <= v.drawW / 2 && Math.abs(py - cy) <= v.drawH / 2;
            if (!inside) v.close();
        }
    }

    // The photo.
    Item {
        id: stage
        width: v.width
        height: v.height
        clip: true

        Item {
            id: pic
            width: v.drawW
            height: v.drawH
            x: (stage.width - width) / 2 + v.panX
            y: (stage.height - height) / 2 + v.panY

            // The small copy the chat already has, until the full-size one is there.
            Image {
                id: thumb
                anchors.fill: parent
                visible: full.status !== Image.Ready && anim.status !== Image.Ready
                asynchronous: true
                fillMode: Image.Stretch
                smooth: true
                source: v.item ? "image://att/" + v.item.id : ""
                sourceSize: Qt.size(Math.ceil(280 * v.dpr), Math.ceil(360 * v.dpr))
            }
            // The full-size file. Not kept in the image cache (it is big). If it can't be read (HEIC), the hub's large
            // converted copy shows instead.
            Image {
                id: full
                anchors.fill: parent
                visible: !v.isGif || anim.status !== Image.Ready
                asynchronous: true
                cache: false
                smooth: true
                mipmap: true
                fillMode: Image.Stretch
                source: v.item ? "image://att/" + v.item.id + "?full=" + (v.fallback ? "0" : "1") : ""
                sourceSize: v.fallback ? Qt.size(2560, 2560) : Qt.size(0, 0)
                onStatusChanged: {
                    if (status === Image.Ready) { v.fullW = implicitWidth; v.fullH = implicitHeight; }
                    else if (status === Image.Error && !v.fallback) v.fallback = true;
                }
            }
            // Animated GIFs play from the original file.
            AnimatedImage {
                id: anim
                anchors.fill: parent
                visible: status === Image.Ready
                asynchronous: true
                cache: false
                smooth: true
                playing: visible
                fillMode: Image.Stretch
                source: v.animSource
                onStatusChanged: if (status === Image.Ready) { v.fullW = implicitWidth; v.fullH = implicitHeight; }
            }
        }
        Text {
            anchors.centerIn: parent
            visible: full.status === Image.Error && thumb.status !== Image.Ready
            text: "Photo unavailable"
            color: "white"
            font.pixelSize: 14
        }

        // Zoom with the wheel or a touchpad's two-finger scroll and pinch.
        WheelHandler {
            acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
            onWheel: event => {
                const dy = event.angleDelta.y !== 0 ? event.angleDelta.y : event.pixelDelta.y * 2;
                v.zoomAt(v.zoom * Math.pow(1.0016, dy), point.position.x, point.position.y);
            }
        }
        PinchHandler {
            id: pinch
            target: null
            property real startZoom: 1
            onActiveChanged: if (active) startZoom = v.zoom
            onActiveScaleChanged: if (active) v.zoomAt(startZoom * activeScale, centroid.position.x, centroid.position.y)
        }
        DragHandler {
            id: drag
            target: null
            enabled: v.drawW > stage.width + 1 || v.drawH > stage.height + 1
            cursorShape: active ? Qt.ClosedHandCursor : Qt.ArrowCursor
            property real startX: 0
            property real startY: 0
            onActiveChanged: if (active) { startX = v.panX; startY = v.panY; }
            onTranslationChanged: if (active) { v.panX = startX + translation.x; v.panY = startY + translation.y; v.clampPan(); }
        }
        TapHandler {
            acceptedButtons: Qt.LeftButton
            onDoubleTapped: (point, button) => v.toggleZoom(point.position.x, point.position.y)
        }
    }

    property bool fallback: false
    onIndexChanged: fallback = false

    // ---- controls ----
    component Pill: Rectangle {
        id: pill
        property string label
        property string glyph
        property bool wide: true
        signal clicked()
        height: 32
        width: wide ? txt.implicitWidth + 28 : 32
        radius: 16
        color: area.containsMouse ? Qt.rgba(1, 1, 1, 0.26) : Qt.rgba(1, 1, 1, 0.16)
        Text { id: txt; anchors.centerIn: parent; text: pill.label; color: "white"; font.pixelSize: 12; font.family: Theme.boldFont; font.weight: Font.DemiBold; visible: pill.wide }
        MouseArea { id: area; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: pill.clicked() }
    }

    // Top: the position and the actions.
    Row {
        id: bar
        y: 14
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: 8
        Pill { label: "Open in default app"; onClicked: if (v.item) Hub.openAttachment(v.item.id, v.item.filename) }
        Pill { label: "Save As"; onClicked: if (v.item) Hub.saveAttachment(v.item.id, v.item.filename, v.item.mime) }
        Pill {
            label: copied.running ? "Copied" : "Copy image"
            onClicked: if (v.item) { Hub.copyImage(v.item.id); copied.restart(); }
            Timer { id: copied; interval: 1600 }
        }
        Pill { label: "Close"; onClicked: v.close() }
    }
    Text {
        anchors.horizontalCenter: parent.horizontalCenter
        y: parent.height - 38
        visible: v.items.length > 1
        text: (v.index + 1) + " of " + v.items.length
        color: Qt.rgba(1, 1, 1, 0.7)
        font.pixelSize: 12
    }

    // Side arrows.
    component Arrow: Rectangle {
        id: arrow
        property int dir: 1
        signal clicked()
        width: 44
        height: 44
        radius: 22
        color: area.containsMouse ? Qt.rgba(1, 1, 1, 0.28) : Qt.rgba(1, 1, 1, 0.16)
        Glyph {
            anchors.centerIn: parent
            name: "back"
            width: 20
            height: 20
            color: "white"
            stroke: 2
            rotation: arrow.dir > 0 ? 180 : 0
        }
        MouseArea { id: area; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: arrow.clicked() }
    }
    Arrow {
        x: 18
        anchors.verticalCenter: parent.verticalCenter
        visible: v.index > 0
        dir: -1
        onClicked: v.step(-1)
    }
    Arrow {
        x: parent.width - width - 18
        anchors.verticalCenter: parent.verticalCenter
        visible: v.index >= 0 && v.index < v.items.length - 1
        dir: 1
        onClicked: v.step(1)
    }
}
