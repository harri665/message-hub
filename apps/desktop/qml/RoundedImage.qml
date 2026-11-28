import QtQuick
import QtQuick.Window

// An attachment photo clipped to rounded corners by a tiny shader (no offscreen layer, so no extra copy in memory).
// The picture always keeps its own proportions: if the box has a different shape it is cropped in the middle (like
// Image.PreserveAspectCrop), never stretched.
Item {
    id: r
    property string source
    property real radius: 16
    property bool flatBottom: false
    // The size to decode the picture at, in device pixels (the picture is never decoded larger). By default the size of
    // this item; a caller whose size depends on the picture sets a fixed upper bound instead, so the picture is not
    // asked for again every time the item changes size.
    property size decodeSize: Qt.size(Math.ceil(r.width * Screen.devicePixelRatio), Math.ceil(r.height * Screen.devicePixelRatio))
    readonly property alias status: img.status
    readonly property alias implicitImageSize: img.sourceSize
    // The size of the decoded picture (as returned by the provider, so already upright), 0x0 until it has loaded.
    readonly property size natural: img.status === Image.Ready ? Qt.size(img.implicitWidth, img.implicitHeight) : Qt.size(0, 0)
    readonly property bool software: GraphicsInfo.api === GraphicsInfo.Software
    // Share of the picture that shows in x and y.
    readonly property real boxAspect: r.height > 0 ? r.width / r.height : 1
    readonly property real imageAspect: natural.height > 0 ? natural.width / natural.height : boxAspect
    readonly property size crop: imageAspect > boxAspect ? Qt.size(boxAspect / imageAspect, 1) : Qt.size(1, imageAspect / boxAspect)

    Image {
        id: img
        anchors.fill: parent
        // Drawn by the shader below, but must stay "visible" to keep its texture. The software renderer has no shaders:
        // there the plain image shows, with square corners.
        opacity: r.software ? 1 : 0
        asynchronous: true
        cache: true
        source: r.source
        fillMode: r.software ? Image.PreserveAspectCrop : Image.Stretch
        clip: r.software
        // Bound by the decode size, not by this item's own size: decoding is by the provider (fits inside, keeps the
        // aspect and the EXIF rotation), the shader or PreserveAspectCrop does the fitting.
        sourceSize: r.decodeSize
    }
    ShaderEffect {
        anchors.fill: parent
        visible: !r.software && img.status === Image.Ready
        property variant source: img
        property size size: Qt.size(width, height)
        property real radius: r.radius
        property real flatBottom: r.flatBottom ? 1 : 0
        property size uvScale: r.crop
        fragmentShader: "qrc:/shaders/roundedimage.frag.qsb"
    }
}
