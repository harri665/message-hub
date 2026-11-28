#version 440
// The lit edge of a pane of glass, over a rounded rectangle: the rim brightens where the edge faces the light (top left)
// and, more faintly, on the opposite edge (bottom right), with a soft sheen just inside the lit edge, as on Liquid
// Glass. Elsewhere it draws nothing, so the glass behind shows through untouched. White light, premultiplied output.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 size;
    float radius;
    float rimWidth;  // px
    float rim;       // opacity of the rim where it faces the light
    float sheen;     // opacity of the sheen inside the lit edge (0 = none)
};

void main() {
    vec2 p = qt_TexCoord0 * size;
    vec2 h = size * 0.5;
    vec2 c = p - h;
    vec2 q = abs(c) - (h - vec2(radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;  // signed distance to the edge, < 0 inside

    // Outward normal of the nearest edge (smoothed, so it turns gradually through the corners and has no seam inside),
    // and how much it faces the light.
    vec2 n = normalize(sign(c + vec2(1e-4)) * exp((abs(c) - h) / max(radius, 4.0)));
    float facing = dot(n, normalize(vec2(-0.5, -1.0)));
    float lit = pow(max(facing, 0.0), 1.5) + 0.4 * pow(max(-facing, 0.0), 2.0);

    float inside = clamp(0.5 - d, 0.0, 1.0);
    float stroke = inside * clamp(d + rimWidth + 0.5, 0.0, 1.0);
    float a = rim * lit * stroke;
    // The sheen fades over about 16 px inward from the lit edge.
    a += sheen * inside * (1.0 - stroke) * exp(d / 16.0) * pow(max(facing, 0.0), 2.0);
    fragColor = vec4(a) * qt_Opacity;
}
