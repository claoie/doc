//! JavaScript number behaviour beyond `jsutil`: `toPrecision`, `Math.round`, `**`.
//!
//! The formula engine and the cell helpers lean on a handful of number
//! operations whose JavaScript results differ from the nearest Rust call.
//! Each function here names the JavaScript expression it stands for and is
//! held to Bun's output by `tests/numbers.rs`.

use crate::jsutil::number_to_string;

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n == n.trunc()
}

/// The first `precision` significant digits of a positive finite `x`, rounded
/// the way `toPrecision` rounds, and the decimal exponent of the first digit.
///
/// The specification asks for the decimal closest to `x` and, when two are
/// equally close, the larger one. Rust's formatter is exact but breaks such
/// ties toward the even digit, so it is only trusted one digit further than
/// needed: unless that extra digit is a `5` it already decides the rounding.
/// A `5` may be an exact tie or lie just to either side of one, so that case
/// is settled on the exact decimal expansion of the double (at most 767
/// significant digits, which an 800-digit format prints in full).
fn rounded_digits(x: f64, precision: usize) -> (Vec<u8>, i32) {
    let split = |text: &str| -> (Vec<u8>, i32) {
        let (mantissa, exponent) = text.split_once('e').expect("exponent form");
        (mantissa.bytes().filter(|b| *b != b'.').collect(), exponent.parse().expect("exponent"))
    };
    let (mut digits, mut exponent) = split(&format!("{:.*e}", precision, x));
    let round_up = if digits[precision] == b'5' {
        let (exact, exact_exponent) = split(&format!("{:.800e}", x));
        exponent = exact_exponent;
        digits = exact[..precision].to_vec();
        exact[precision] >= b'5'
    } else {
        digits[precision] > b'5'
    };
    digits.truncate(precision);
    if round_up {
        let mut i = precision;
        loop {
            if i == 0 {
                // 99…9 rounded up: one more digit in front.
                digits.insert(0, b'1');
                digits.truncate(precision);
                exponent += 1;
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    (digits, exponent)
}

/// `n.toPrecision(precision)`, for `precision` in `1..=100` (JavaScript throws
/// a RangeError outside that range; here it is a caller bug and panics).
pub fn to_precision(n: f64, precision: usize) -> String {
    assert!((1..=100).contains(&precision), "toPrecision() argument must be between 1 and 100");
    if !n.is_finite() {
        return number_to_string(n);
    }
    let (digits, exponent) = if n == 0.0 { (vec![b'0'; precision], 0) } else { rounded_digits(n.abs(), precision) };
    let digits = std::str::from_utf8(&digits).expect("ASCII digits");
    let mut out = String::with_capacity(precision + 8);
    // Negative zero prints without a sign, as in JavaScript.
    if n < 0.0 {
        out.push('-');
    }
    let p = precision as i32;
    if exponent < -6 || exponent >= p {
        out.push_str(&digits[..1]);
        if precision > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exponent < 0 { '-' } else { '+' });
        out.push_str(&exponent.abs().to_string());
    } else if exponent == p - 1 {
        out.push_str(digits);
    } else if exponent >= 0 {
        let point = exponent as usize + 1;
        out.push_str(&digits[..point]);
        out.push('.');
        out.push_str(&digits[point..]);
    } else {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-(exponent + 1)) as usize));
        out.push_str(digits);
    }
    out
}

/// `Math.round(x)`: the nearest integer, halves toward +∞, keeping the sign
/// of zero (`Math.round(-0.2)` is `-0`). Written with `floor` and an exact
/// difference rather than `floor(x + 0.5)`, which is wrong for
/// `0.49999999999999994` and for odd integers above 2^52.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// The largest integer exponent JavaScriptCore raises by repeated squaring.
const MAX_INTEGER_EXPONENT: i32 = 1000;

/// `x ** y` as JavaScriptCore computes it.
///
/// Besides the cases where JavaScript differs from C (`NaN` for a NaN
/// exponent, and for `±1 ** ±Infinity`), the engine has its own paths whose
/// rounding shows in the last bits: exponents `0.5` and `-0.5` go through the
/// square root, and whole exponents from 0 to 1000 are computed by repeated
/// squaring (`10 ** 308` is `1.0000000000000006e308` there). Everything else
/// is the C library's `pow`.
pub fn pow(x: f64, y: f64) -> f64 {
    if y.is_nan() {
        return f64::NAN;
    }
    let magnitude = x.abs();
    if magnitude == 1.0 && y.is_infinite() {
        return f64::NAN;
    }
    if y == 0.5 {
        if magnitude == 0.0 {
            return 0.0;
        }
        if magnitude == f64::INFINITY {
            return f64::INFINITY;
        }
        return x.sqrt();
    }
    if y == -0.5 {
        if magnitude == 0.0 {
            return f64::INFINITY;
        }
        if magnitude == f64::INFINITY {
            return 0.0;
        }
        return 1.0 / x.sqrt();
    }
    if y >= 0.0 && y <= f64::from(MAX_INTEGER_EXPONENT) && y == y.trunc() {
        let mut exponent = y as i32;
        let mut result = 1.0;
        let mut square = x;
        while exponent != 0 {
            if exponent & 1 == 1 {
                result *= square;
            }
            square *= square;
            exponent >>= 1;
        }
        return result;
    }
    x.powf(y)
}

/// `Math.sign(x)`: NaN stays NaN and both zeros keep their sign.
pub fn math_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// `Math.min(...values)`: `Infinity` for no values, NaN if any value is NaN,
/// and `-0` below `+0`.
pub fn math_min(values: &[f64]) -> f64 {
    let mut result = f64::INFINITY;
    for &value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value < result || (value == 0.0 && result == 0.0 && value.is_sign_negative()) {
            result = value;
        }
    }
    result
}

/// `Math.max(...values)`: `-Infinity` for no values, NaN if any value is NaN,
/// and `+0` above `-0`.
pub fn math_max(values: &[f64]) -> f64 {
    let mut result = f64::NEG_INFINITY;
    for &value in values {
        if value.is_nan() {
            return f64::NAN;
        }
        if value > result || (value == 0.0 && result == 0.0 && value.is_sign_positive()) {
            result = value;
        }
    }
    result
}

/// `ToIntegerOrInfinity(x)`: NaN becomes 0, everything else is truncated.
pub fn to_integer_or_infinity(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        x.trunc() + 0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_precision_rounds_ties_up() {
        assert_eq!(to_precision(0.5, 1), "0.5");
        assert_eq!(to_precision(1.5, 1), "2");
        assert_eq!(to_precision(2.5, 1), "3");
        assert_eq!(to_precision(0.125, 2), "0.13");
        assert_eq!(to_precision(1.45, 2), "1.4");
        assert_eq!(to_precision(1.005, 3), "1.00");
        assert_eq!(to_precision(1234.5, 4), "1235");
        assert_eq!(to_precision(-1234.5, 4), "-1235");
        assert_eq!(to_precision(999999999999.5, 12), "1.00000000000e+12");
        assert_eq!(to_precision(5e-324, 3), "4.94e-324");
        assert_eq!(to_precision(0.0, 3), "0.00");
        assert_eq!(to_precision(-0.0, 3), "0.00");
        assert_eq!(to_precision(1e21, 5), "1.0000e+21");
        assert_eq!(to_precision(123456.0, 2), "1.2e+5");
        assert_eq!(to_precision(123456.0, 8), "123456.00");
        assert_eq!(to_precision(0.000001234, 2), "0.0000012");
        assert_eq!(to_precision(1e-7, 3), "1.00e-7");
        assert_eq!(to_precision(f64::NAN, 3), "NaN");
        assert_eq!(to_precision(f64::NEG_INFINITY, 3), "-Infinity");
    }

    #[test]
    fn rounds_like_math_round() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert_eq!(math_round(4503599627370495.5), 4503599627370496.0);
        assert_eq!(math_round(-4503599627370495.5), -4503599627370495.0);
        assert!(math_round(-0.2).is_sign_negative());
        assert!(math_round(-0.5).is_sign_negative());
        assert!(math_round(f64::NAN).is_nan());
    }

    #[test]
    fn powers_like_javascript() {
        assert!(pow(1.0, f64::NAN).is_nan());
        assert!(pow(1.0, f64::INFINITY).is_nan());
        assert!(pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert_eq!(pow(f64::NAN, 0.0), 1.0);
        assert_eq!(pow(10.0, 308.0), 1.0000000000000006e308);
        assert_eq!(pow(1.1, 10.0), 2.593742460100002);
        assert_eq!(pow(2.0, -0.5), 0.7071067811865475);
        assert_eq!(pow(10.0, -2.0), 0.01);
    }

    #[test]
    fn min_max_sign() {
        assert!(math_min(&[0.0, -0.0]).is_sign_negative());
        assert!(math_max(&[-0.0, 0.0]).is_sign_positive());
        assert!(math_min(&[1.0, f64::NAN]).is_nan());
        assert_eq!(math_min(&[]), f64::INFINITY);
        assert!(math_sign(-0.0).is_sign_negative());
        assert_eq!(math_sign(-3.0), -1.0);
    }
}
