package dev.evumi.honk.core

import dev.evumi.honk.core.SvgPath.Op
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

class SvgPathTest {
    private fun end(op: Op): Pair<Float, Float>? = when (op) {
        is Op.MoveTo -> op.x to op.y
        is Op.LineTo -> op.x to op.y
        is Op.CubicTo -> op.x to op.y
        Op.Close -> null
    }

    @Test fun linesRelativeAndAbsolute() {
        val ops = SvgPath.parse("M1 2 L3 4 l1 1 H10 h-2 V0 v5 z")
        assertEquals(
            listOf(
                Op.MoveTo(1f, 2f), Op.LineTo(3f, 4f), Op.LineTo(4f, 5f), Op.LineTo(10f, 5f), Op.LineTo(8f, 5f),
                Op.LineTo(8f, 0f), Op.LineTo(8f, 5f), Op.Close,
            ),
            ops,
        )
    }

    @Test fun repeatedCoordinatesAreImplicitLines() {
        assertEquals(listOf(Op.MoveTo(0f, 0f), Op.LineTo(1f, 1f), Op.LineTo(2f, 0f)), SvgPath.parse("M0 0 1 1 2 0"))
        assertEquals(listOf(Op.MoveTo(0f, 0f), Op.LineTo(1f, 1f), Op.LineTo(2f, 2f)), SvgPath.parse("m0 0 1 1 1 1"))
    }

    @Test fun numbersMayTouch() {
        // `-` and `.` start a new number; the icons are written this way ("0-17", ".01").
        assertEquals(listOf(Op.MoveTo(7f, 7.5f), Op.LineTo(7.01f, 7.5f)), SvgPath.parse("M7 7.5h.01"))
        assertEquals(listOf(Op.MoveTo(1.5f, 0.5f), Op.LineTo(0.5f, -1f)), SvgPath.parse("M1.5.5l-1-1.5"))
    }

    @Test fun cubicsQuadsAndSmoothCommands() {
        val c = SvgPath.parse("M0 0 C1 1 2 1 3 0 s2 -1 3 0")
        assertEquals(Op.CubicTo(4f, -1f, 5f, -1f, 6f, 0f), c[2])
        val q = SvgPath.parse("M0 0 Q3 3 6 0")
        // The quad's cubic keeps its end points and control points two thirds of the way.
        assertEquals(Op.CubicTo(2f, 2f, 4f, 2f, 6f, 0f), q[1])
    }

    @Test fun arcsAreCubicsThatStayOnTheEllipse() {
        // The check icon's circle: two half arcs of radius 8.5 around (12, 12).
        val ops = SvgPath.parse("M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z")
        assertTrue(ops.size > 4)
        var x = 12f
        var y = 3.5f
        for (op in ops) {
            if (op is Op.CubicTo) {
                // A cubic of a quarter turn at t = 0.5.
                fun at(a: Float, b: Float, c: Float, d: Float) = 0.125f * a + 0.375f * b + 0.375f * c + 0.125f * d
                val mx = at(x, op.x1, op.x2, op.x)
                val my = at(y, op.y1, op.y2, op.y)
                assertEquals("on the circle", 8.5, hypot(mx - 12.0, my - 12.0), 0.01)
                x = op.x
                y = op.y
            }
        }
        assertEquals(12f, x, 1e-4f)
        assertEquals(3.5f, y, 1e-4f)
    }

    @Test fun arcFlagsMayTouchTheNextNumber() {
        val spaced = SvgPath.parse("M0 0a1 1 0 0 1 2 0")
        val packed = SvgPath.parse("M0 0a1 1 0 01 2 0")
        assertEquals(spaced, packed)
        assertEquals(2f, (end(spaced.last()) ?: error("no end")).first, 1e-5f)
        // The sweep flag decides which side the half circle bulges to.
        val up = SvgPath.parse("M0 0A1 1 0 0 1 2 0")[1] as Op.CubicTo
        val down = SvgPath.parse("M0 0A1 1 0 0 0 2 0")[1] as Op.CubicTo
        assertTrue(up.y1 < 0 && down.y1 > 0)
    }

    @Test fun radiiThatAreTooSmallAreScaledUp() {
        val ops = SvgPath.parse("M0 0A0.1 0.1 0 0 1 4 0")
        assertEquals(4f, (end(ops.last()) ?: error("no end")).first, 1e-5f)
    }

    @Test fun badDataIsRejected() {
        assertThrows(SvgPath.ParseException::class.java) { SvgPath.parse("L1 1") }
        assertThrows(SvgPath.ParseException::class.java) { SvgPath.parse("M0 0 X1 1") }
        assertThrows(SvgPath.ParseException::class.java) { SvgPath.parse("M0 0 L1") }
        assertThrows(SvgPath.ParseException::class.java) { SvgPath.parse("M0 0 z 1 1") }
        assertEquals(emptyList<Op>(), SvgPath.parse("  "))
    }

    @Test fun everyPresetIconParsesAndFitsTheGrid() {
        // The icons the app offers are the ones the notification draws.
        assertEquals(Avatar.ICONS, AvatarIcons.PATHS.keys)
        for ((name, d) in AvatarIcons.PATHS) {
            val ops = SvgPath.parse(d)
            assertTrue("$name has a path", ops.size > 1)
            assertTrue("$name starts with a move", ops.first() is Op.MoveTo)
            for (op in ops) {
                val pts = when (op) {
                    is Op.MoveTo -> listOf(op.x to op.y)
                    is Op.LineTo -> listOf(op.x to op.y)
                    is Op.CubicTo -> listOf(op.x1 to op.y1, op.x2 to op.y2, op.x to op.y)
                    Op.Close -> emptyList()
                }
                for ((px, py) in pts) assertTrue("$name: ($px, $py) inside the 24 grid", px in -0.5f..24.5f && py in -0.5f..24.5f)
            }
        }
    }

    @Test fun absoluteAndRelativeEndPointsAgree() {
        // `M10.3 21a1.9 1.9 0 0 0 3.4 0` ends 3.4 to the right of where it began.
        val e = end(SvgPath.parse("M10.3 21a1.9 1.9 0 0 0 3.4 0").last()) ?: error("no end")
        assertTrue(abs(e.first - 13.7f) < 1e-4f && abs(e.second - 21f) < 1e-4f)
    }
}
