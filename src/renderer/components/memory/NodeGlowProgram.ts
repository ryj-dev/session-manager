/**
 * Custom Sigma.js node program with glow effect.
 * Ported from tc-sql-atlas NodeGlowProgram.ts.
 */
import { NodeProgram } from 'sigma/rendering'
import { NodeDisplayData, RenderParams } from 'sigma/types'
import { floatColor } from 'sigma/utils'
import type { Attributes } from 'graphology-types'

const VERTEX_SHADER = /*glsl*/ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;

uniform float u_sizeRatio;
uniform float u_pixelRatio;
uniform mat3 u_matrix;

varying vec4 v_color;
varying float v_border;

const float bias = 255.0 / 254.0;

void main() {
  gl_Position = vec4(
    (u_matrix * vec3(a_position, 1)).xy,
    0,
    1
  );

  gl_PointSize = a_size / u_sizeRatio * u_pixelRatio * 4.0;
  v_border = (0.5 / a_size) * u_sizeRatio;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`

const FRAGMENT_SHADER = /*glsl*/ `
precision mediump float;

varying vec4 v_color;
varying float v_border;

const float radius = 0.5;
const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  vec2 m = gl_PointCoord - vec2(0.5, 0.5);
  float rawDist = length(m);

  #ifdef PICKING_MODE
  if (rawDist < 0.15)
    gl_FragColor = v_color;
  else
    gl_FragColor = transparent;
  #else
  float dist = rawDist * 2.0;
  float core = smoothstep(0.2, 0.0, dist);
  float glow = exp(-dist * dist * 4.0);
  float t = core * 0.7 + glow * 0.5;
  gl_FragColor = mix(transparent, v_color, t);
  #endif
}
`

const { UNSIGNED_BYTE, FLOAT } = WebGLRenderingContext

const UNIFORMS = ['u_sizeRatio', 'u_pixelRatio', 'u_matrix'] as const

export default class NodeGlowProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
> extends NodeProgram<(typeof UNIFORMS)[number], N, E, G> {
  getDefinition() {
    return {
      VERTICES: 1,
      VERTEX_SHADER_SOURCE: VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: FRAGMENT_SHADER,
      METHOD: 0 as 0,
      UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: FLOAT },
        { name: 'a_size', size: 1, type: FLOAT },
        { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
      ],
      CONSTANT_ATTRIBUTES: [] as { name: string; size: number; type: number }[],
      CONSTANT_DATA: [[]] as number[][],
    }
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData) {
    const array = this.array
    array[startIndex++] = data.x
    array[startIndex++] = data.y
    array[startIndex++] = data.size
    array[startIndex++] = floatColor(data.color)
    array[startIndex++] = nodeIndex
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: { gl: WebGLRenderingContext; uniformLocations: Record<string, WebGLUniformLocation> }) {
    const { u_sizeRatio, u_pixelRatio, u_matrix } = uniformLocations
    gl.uniform1f(u_sizeRatio, params.sizeRatio)
    gl.uniform1f(u_pixelRatio, params.pixelRatio)
    gl.uniformMatrix3fv(u_matrix, false, params.matrix)
  }
}
