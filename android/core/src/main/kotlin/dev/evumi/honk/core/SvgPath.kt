package dev.evumi.honk.core

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * SVG path data (the `d` of a `<path>`, as the preset avatar icons in [AvatarIcons] are written) reduced to
 * absolute moves, lines, cubic curves and closes, which android.graphics.Path draws directly. Quadratic curves and
 * arcs become cubics. Pure Kotlin, so it is tested on the JVM; the app only maps [Op]s onto a Path.
 */
object SvgPath {
    sealed class Op {
        data class MoveTo(val x: Float, val y: Float) : Op()
        data class LineTo(val x: Float, val y: Float) : Op()
        data class CubicTo(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val x: Float, val y: Float) : Op()
        object Close : Op()
    }

    class ParseException(message: String) : IllegalArgumentException(message)

    /** Parses [d]; throws [ParseException] when it is not valid path data. */
    fun parse(d: String): List<Op> = Parser(d).run()

    private class Parser(val s: String) {
        var i = 0
        val ops = mutableListOf<Op>()
        var cx = 0.0
        var cy = 0.0
        var startX = 0.0
        var startY = 0.0
        // The last control point, for the smooth commands S and T.
        var lastCubic: Pair<Double, Double>? = null
        var lastQuad: Pair<Double, Double>? = null

        fun run(): List<Op> {
            skipSeparators()
            if (i >= s.length) return ops
            if (s[i] != 'M' && s[i] != 'm') throw ParseException("path data must start with a move")
            var cmd = ' '
            while (true) {
                skipSeparators()
                if (i >= s.length) break
                val c = s[i]
                if (c.isLetter()) {
                    cmd = c
                    i++
                } else if (cmd == ' ' || cmd == 'Z' || cmd == 'z') {
                    throw ParseException("unexpected number at $i")
                } else if (cmd == 'M') {
                    cmd = 'L'
                } else if (cmd == 'm') {
                    cmd = 'l'
                }
                command(cmd)
            }
            return ops
        }

        fun command(c: Char) {
            val rel = c.isLowerCase()
            fun x(v: Double) = if (rel) cx + v else v
            fun y(v: Double) = if (rel) cy + v else v
            var cubic: Pair<Double, Double>? = null
            var quad: Pair<Double, Double>? = null
            when (c.uppercaseChar()) {
                'M' -> {
                    val px = x(num()); val py = y(num())
                    ops += Op.MoveTo(px.toFloat(), py.toFloat())
                    cx = px; cy = py; startX = px; startY = py
                }
                'L' -> line(x(num()), y(num()))
                'H' -> line(if (rel) cx + num() else num(), cy)
                'V' -> line(cx, if (rel) cy + num() else num())
                'C' -> {
                    val x1 = x(num()); val y1 = y(num()); val x2 = x(num()); val y2 = y(num()); val px = x(num()); val py = y(num())
                    cubicTo(x1, y1, x2, y2, px, py)
                    cubic = x2 to y2
                }
                'S' -> {
                    val x2 = x(num()); val y2 = y(num()); val px = x(num()); val py = y(num())
                    val lc = lastCubic
                    val x1 = if (lc != null) 2 * cx - lc.first else cx
                    val y1 = if (lc != null) 2 * cy - lc.second else cy
                    cubicTo(x1, y1, x2, y2, px, py)
                    cubic = x2 to y2
                }
                'Q' -> {
                    val x1 = x(num()); val y1 = y(num()); val px = x(num()); val py = y(num())
                    quadTo(x1, y1, px, py)
                    quad = x1 to y1
                }
                'T' -> {
                    val px = x(num()); val py = y(num())
                    val lq = lastQuad
                    val x1 = if (lq != null) 2 * cx - lq.first else cx
                    val y1 = if (lq != null) 2 * cy - lq.second else cy
                    quadTo(x1, y1, px, py)
                    quad = x1 to y1
                }
                'A' -> {
                    val rx = num(); val ry = num(); val rot = num(); val large = flag(); val sweep = flag()
                    arc(rx, ry, rot, large, sweep, x(num()), y(num()))
                }
                'Z' -> {
                    ops += Op.Close
                    cx = startX; cy = startY
                }
                else -> throw ParseException("unknown command $c")
            }
            lastCubic = cubic
            lastQuad = quad
        }

        fun line(px: Double, py: Double) {
            ops += Op.LineTo(px.toFloat(), py.toFloat())
            cx = px; cy = py
        }

        fun cubicTo(x1: Double, y1: Double, x2: Double, y2: Double, px: Double, py: Double) {
            ops += Op.CubicTo(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), px.toFloat(), py.toFloat())
            cx = px; cy = py
        }

        fun quadTo(x1: Double, y1: Double, px: Double, py: Double) {
            cubicTo(cx + 2.0 / 3 * (x1 - cx), cy + 2.0 / 3 * (y1 - cy), px + 2.0 / 3 * (x1 - px), py + 2.0 / 3 * (y1 - py), px, py)
        }

        /** An elliptical arc as cubics (SVG 1.1 implementation notes, F.6): at most a quarter turn each. */
        fun arc(rxIn: Double, ryIn: Double, rotDeg: Double, large: Boolean, sweep: Boolean, px: Double, py: Double) {
            var rx = abs(rxIn)
            var ry = abs(ryIn)
            if (px == cx && py == cy) return
            if (rx == 0.0 || ry == 0.0) return line(px, py)
            val phi = rotDeg * PI / 180
            val cosP = cos(phi)
            val sinP = sin(phi)
            val dx = (cx - px) / 2
            val dy = (cy - py) / 2
            val x1p = cosP * dx + sinP * dy
            val y1p = -sinP * dx + cosP * dy
            // Radii too small to reach the end point are scaled up.
            val lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry)
            if (lambda > 1) {
                val k = sqrt(lambda)
                rx *= k; ry *= k
            }
            val num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
            val den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
            val coef = (if (large == sweep) -1 else 1) * sqrt(maxOf(0.0, num / den))
            val cxp = coef * rx * y1p / ry
            val cyp = -coef * ry * x1p / rx
            val ccx = cosP * cxp - sinP * cyp + (cx + px) / 2
            val ccy = sinP * cxp + cosP * cyp + (cy + py) / 2
            val theta1 = atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
            var delta = atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - theta1
            if (sweep && delta < 0) delta += 2 * PI
            if (!sweep && delta > 0) delta -= 2 * PI
            val n = ceil(abs(delta) / (PI / 2) - 1e-9).toInt().coerceAtLeast(1)
            val step = delta / n
            val t = 4.0 / 3 * tan(step / 4)
            var a = theta1
            var sx = cx
            var sy = cy
            for (k in 1..n) {
                val b = a + step
                // Unit-circle control points, then scaled, rotated and moved onto the ellipse.
                val c1x = cos(a) - t * sin(a); val c1y = sin(a) + t * cos(a)
                val c2x = cos(b) + t * sin(b); val c2y = sin(b) - t * cos(b)
                fun mx(ux: Double, uy: Double) = ccx + cosP * rx * ux - sinP * ry * uy
                fun my(ux: Double, uy: Double) = ccy + sinP * rx * ux + cosP * ry * uy
                val ex = if (k == n) px else mx(cos(b), sin(b))
                val ey = if (k == n) py else my(cos(b), sin(b))
                cubicTo(mx(c1x, c1y), my(c1x, c1y), mx(c2x, c2y), my(c2x, c2y), ex, ey)
                a = b
                sx = ex; sy = ey
            }
            cx = sx; cy = sy
        }

        fun skipSeparators() {
            while (i < s.length && (s[i].isWhitespace() || s[i] == ',')) i++
        }

        /** An arc flag: a single `0` or `1`, which may touch the next number. */
        fun flag(): Boolean {
            skipSeparators()
            if (i >= s.length || (s[i] != '0' && s[i] != '1')) throw ParseException("expected an arc flag at $i")
            return (s[i++] == '1')
        }

        fun num(): Double {
            skipSeparators()
            val start = i
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            var digits = 0
            while (i < s.length && s[i].isDigit()) { i++; digits++ }
            if (i < s.length && s[i] == '.') {
                i++
                while (i < s.length && s[i].isDigit()) { i++; digits++ }
            }
            if (digits == 0) throw ParseException("expected a number at $start")
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                val save = i
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i < s.length && s[i].isDigit()) while (i < s.length && s[i].isDigit()) i++ else i = save
            }
            return s.substring(start, i).toDouble()
        }
    }
}
