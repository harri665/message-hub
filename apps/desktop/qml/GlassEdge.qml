import QtQuick

// The lit edge of a pane of glass (shaders/glassrim.frag): a rim that catches the light at the top left and, fainter,
// the bottom right, and a soft sheen inside the lit edge. It goes over a rounded rectangle of the same size and radius,
// whose own border is the edge's base colour. Draws nothing with the software renderer (no shaders).
Item {
    id: edge
    property real radius
    property real rimWidth: 1
    property real rim: 0.5
    property real sheen: 0

    ShaderEffect {
        anchors.fill: parent
        visible: GraphicsInfo.api !== GraphicsInfo.Software && edge.rim + edge.sheen > 0
        property size size: Qt.size(width, height)
        property real radius: edge.radius
        property real rimWidth: edge.rimWidth
        property real rim: edge.rim
        property real sheen: edge.sheen
        fragmentShader: "qrc:/shaders/glassrim.frag.qsb"
    }
}
