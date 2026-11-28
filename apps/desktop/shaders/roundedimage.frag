#version 440
// Draws an image clipped to a rounded rectangle (anti-aliased), without an offscreen layer.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 size;
    float radius;
    float flatBottom;  // 1: the lower corners are square (a picture on top of a card)
};
layout(binding = 1) uniform sampler2D source;

void main() {
    vec2 p = qt_TexCoord0 * size;
    vec2 h = size * 0.5;
    float r = (flatBottom > 0.5 && p.y > h.y) ? 0.0 : radius;
    vec2 q = abs(p - h) - (h - vec2(r));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float a = clamp(0.5 - d, 0.0, 1.0);
    fragColor = texture(source, qt_TexCoord0) * (a * qt_Opacity);
}
