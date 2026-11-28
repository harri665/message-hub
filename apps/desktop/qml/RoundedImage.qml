import QtQuick
import QtQuick.Window

// An attachment photo clipped to rounded corners by a tiny shader (no offscreen layer, so no extra copy in memory).
Item {
    id: r
    property string source
    property real radius: 16
    property bool flatBottom: false
    readonly property alias status: img.status
    readonly property alias implicitImageSize: img.sourceSize
    readonly property bool software: GraphicsInfo.api === GraphicsInfo.Software

    Image {
        id: img
        anchors.fill: parent
        // Drawn by the shader below, but must stay "visible" to keep its texture. The software renderer has no shaders:
        // there the plain image shows, with square corners.
        opacity: r.software ? 1 : 0
        asynchronous: true
        cache: true
        source: r.source
        fillMode: Image.Stretch
        sourceSize: Qt.size(Math.ceil(r.width * Screen.devicePixelRatio), Math.ceil(r.height * Screen.devicePixelRatio))
    }
    ShaderEffect {
        anchors.fill: parent
        visible: !r.software && img.status === Image.Ready
        property variant source: img
        property size size: Qt.size(width, height)
        property real radius: r.radius
        property real flatBottom: r.flatBottom ? 1 : 0
        fragmentShader: "qrc:/shaders/roundedimage.frag.qsb"
    }
}
