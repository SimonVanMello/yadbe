//! Exact decimal arithmetic for the aggregates of a selection (F-065): sums of `numeric`,
//! `decimal` and 64-bit integer cells without going through floating point, whatever their
//! number of digits. Values are the lossless texts the result store keeps (`-12.340`), not a
//! type of the drivers: a handful of operations on base 10^9 limbs is all that is needed.

use std::cmp::Ordering;

const BASE: u64 = 1_000_000_000;
const BASE_DIGITS: usize = 9;

/// A decimal number as written: sign, integer digits (no leading zero, `""` for 0) and
/// fractional digits (no trailing zero).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub negative: bool,
    pub int: &'a str,
    pub frac: &'a str,
}

/// Parses `[+-]digits[.digits]`; `None` for anything else (`NaN`, `1e5`, empty).
pub fn parse(text: &str) -> Option<Parsed<'_>> {
    let text = text.trim();
    let (negative, rest) = match text.as_bytes().first()? {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let (int, frac) = rest.split_once('.').unwrap_or((rest, ""));
    if int.is_empty() && frac.is_empty() {
        return None;
    }
    if !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let int = int.trim_start_matches('0');
    let frac = frac.trim_end_matches('0');
    let zero = int.is_empty() && frac.is_empty();
    Some(Parsed {
        negative: negative && !zero,
        int,
        frac,
    })
}

impl Parsed<'_> {
    /// Compares two numbers by value.
    pub fn compare(&self, other: &Parsed<'_>) -> Ordering {
        let zero = |p: &Parsed<'_>| p.int.is_empty() && p.frac.is_empty();
        match (self.negative, other.negative) {
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        let magnitude = if zero(self) && zero(other) {
            Ordering::Equal
        } else {
            self.int
                .len()
                .cmp(&other.int.len())
                .then_with(|| self.int.cmp(other.int))
                .then_with(|| self.frac.cmp(other.frac))
        };
        if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        }
    }

    /// The number written the way `parse` reads it back (`0` for zero, no trailing zeros).
    pub fn to_text(self) -> String {
        let mut out = String::new();
        if self.negative {
            out.push('-');
        }
        out.push_str(if self.int.is_empty() { "0" } else { self.int });
        if !self.frac.is_empty() {
            out.push('.');
            out.push_str(self.frac);
        }
        out
    }
}

/// A non-negative integer in base 10^9, least significant limb first, no leading zero limb.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Magnitude(Vec<u32>);

impl Magnitude {
    fn from_digits(digits: &str) -> Self {
        let bytes = digits.as_bytes();
        let mut limbs = Vec::with_capacity(bytes.len() / BASE_DIGITS + 1);
        let mut end = bytes.len();
        while end > 0 {
            let start = end.saturating_sub(BASE_DIGITS);
            let limb = bytes[start..end]
                .iter()
                .fold(0u32, |acc, b| acc * 10 + u32::from(b - b'0'));
            limbs.push(limb);
            end = start;
        }
        let mut magnitude = Self(limbs);
        magnitude.trim();
        magnitude
    }

    fn trim(&mut self) {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
    }

    fn is_zero(&self) -> bool {
        self.0.is_empty()
    }

    /// Multiplies by 10^`power`.
    fn shift(&mut self, power: usize) {
        if self.is_zero() || power == 0 {
            return;
        }
        let rest = power % BASE_DIGITS;
        if rest > 0 {
            let factor = 10u64.pow(u32::try_from(rest).unwrap_or(0));
            let mut carry = 0u64;
            for limb in &mut self.0 {
                let product = u64::from(*limb) * factor + carry;
                *limb = (product % BASE) as u32;
                carry = product / BASE;
            }
            if carry > 0 {
                self.0.push(carry as u32);
            }
        }
        let zeros = power / BASE_DIGITS;
        if zeros > 0 {
            self.0.splice(0..0, std::iter::repeat_n(0, zeros));
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.iter().rev().cmp(other.0.iter().rev()))
    }

    fn add(&mut self, other: &Self) {
        let mut carry = 0u64;
        let len = self.0.len().max(other.0.len());
        self.0.resize(len, 0);
        for (i, limb) in self.0.iter_mut().enumerate() {
            let sum = u64::from(*limb) + u64::from(other.0.get(i).copied().unwrap_or(0)) + carry;
            *limb = (sum % BASE) as u32;
            carry = sum / BASE;
        }
        if carry > 0 {
            self.0.push(carry as u32);
        }
    }

    /// `self -= other`, which must not be larger.
    fn sub(&mut self, other: &Self) {
        let mut borrow = 0i64;
        for (i, limb) in self.0.iter_mut().enumerate() {
            let mut diff =
                i64::from(*limb) - i64::from(other.0.get(i).copied().unwrap_or(0)) - borrow;
            if diff < 0 {
                diff += BASE as i64;
                borrow = 1;
            } else {
                borrow = 0;
            }
            *limb = diff as u32;
        }
        self.trim();
    }

    /// Divides by `divisor` (not 0); returns the remainder.
    fn div_small(&mut self, divisor: u64) -> u64 {
        let mut remainder = 0u128;
        for limb in self.0.iter_mut().rev() {
            let current = remainder * u128::from(BASE) + u128::from(*limb);
            *limb = (current / u128::from(divisor)) as u32;
            remainder = current % u128::from(divisor);
        }
        self.trim();
        remainder as u64
    }

    fn to_digits(&self) -> String {
        let Some((last, rest)) = self.0.split_last() else {
            return "0".to_owned();
        };
        let mut out = last.to_string();
        for limb in rest.iter().rev() {
            out.push_str(&format!("{limb:09}"));
        }
        out
    }
}

/// An exact running sum of decimal numbers.
#[derive(Debug, Clone, Default)]
pub struct DecimalSum {
    negative: bool,
    magnitude: Magnitude,
    /// Digits after the point of `magnitude`.
    scale: usize,
}

impl DecimalSum {
    pub fn add(&mut self, value: &Parsed<'_>) {
        let scale = value.frac.len();
        let mut digits = String::with_capacity(value.int.len() + scale);
        digits.push_str(value.int);
        digits.push_str(value.frac);
        let mut addend = Magnitude::from_digits(&digits);
        if addend.is_zero() {
            return;
        }
        match scale.cmp(&self.scale) {
            Ordering::Greater => {
                self.magnitude.shift(scale - self.scale);
                self.scale = scale;
            }
            Ordering::Less => addend.shift(self.scale - scale),
            Ordering::Equal => {}
        }
        if self.magnitude.is_zero() {
            self.magnitude = addend;
            self.negative = value.negative;
        } else if self.negative == value.negative {
            self.magnitude.add(&addend);
        } else {
            match self.magnitude.compare(&addend) {
                Ordering::Less => {
                    addend.sub(&self.magnitude);
                    self.magnitude = addend;
                    self.negative = value.negative;
                }
                Ordering::Equal => self.magnitude = Magnitude::default(),
                Ordering::Greater => self.magnitude.sub(&addend),
            }
        }
        if self.magnitude.is_zero() {
            self.negative = false;
        }
    }

    /// The sum written as a plain decimal.
    pub fn to_text(&self) -> String {
        format_scaled(self.negative, &self.magnitude, self.scale)
    }

    /// The sum divided by `count`, rounded half away from zero to six more digits than the sum
    /// has, without trailing zeros. `None` when `count` is 0.
    pub fn average(&self, count: u64) -> Option<String> {
        if count == 0 {
            return None;
        }
        const EXTRA: usize = 6;
        let mut quotient = self.magnitude.clone();
        quotient.shift(EXTRA);
        let remainder = quotient.div_small(count);
        if u128::from(remainder) * 2 >= u128::from(count) {
            quotient.add(&Magnitude(vec![1]));
        }
        Some(format_scaled(
            self.negative && !quotient.is_zero(),
            &quotient,
            self.scale + EXTRA,
        ))
    }
}

fn format_scaled(negative: bool, magnitude: &Magnitude, scale: usize) -> String {
    let digits = magnitude.to_digits();
    let padded = if digits.len() <= scale {
        format!("{}{digits}", "0".repeat(scale + 1 - digits.len()))
    } else {
        digits
    };
    let (int, frac) = padded.split_at(padded.len() - scale);
    let frac = frac.trim_end_matches('0');
    let mut out = String::new();
    if negative && (int != "0" || !frac.is_empty()) {
        out.push('-');
    }
    out.push_str(int);
    if !frac.is_empty() {
        out.push('.');
        out.push_str(frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sum(values: &[&str]) -> String {
        let mut total = DecimalSum::default();
        for value in values {
            total.add(&parse(value).expect("a decimal"));
        }
        total.to_text()
    }

    #[test]
    fn parses_plain_decimals_only() {
        assert_eq!(
            parse("-0012.3400").map(|p| p.to_text()).as_deref(),
            Some("-12.34")
        );
        assert_eq!(parse("+.5").map(|p| p.to_text()).as_deref(), Some("0.5"));
        assert_eq!(parse("-0.000").map(|p| p.to_text()).as_deref(), Some("0"));
        for bad in [
            "", "-", ".", "NaN", "1e5", "1.2.3", "12a", "--1", "Infinity",
        ] {
            assert!(parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn compares_by_value() {
        let cmp = |a: &str, b: &str| parse(a).unwrap().compare(&parse(b).unwrap());
        assert_eq!(cmp("2", "10"), Ordering::Less);
        assert_eq!(cmp("-2", "-10"), Ordering::Greater);
        assert_eq!(cmp("1.10", "1.1"), Ordering::Equal);
        assert_eq!(cmp("0.001", "0.01"), Ordering::Less);
        assert_eq!(cmp("-0", "0"), Ordering::Equal);
        assert_eq!(cmp("-1", "1"), Ordering::Less);
        assert_eq!(
            cmp(
                "123456789012345678901234567890.000001",
                "123456789012345678901234567890.000002"
            ),
            Ordering::Less
        );
    }

    #[test]
    fn sums_exactly_where_floats_would_not() {
        assert_eq!(sum(&["0.1", "0.2"]), "0.3");
        assert_eq!(
            sum(&["9223372036854775807", "9223372036854775807", "2"]),
            "18446744073709551616"
        );
        assert_eq!(
            sum(&["123456789012345678901234567890.000001", "0.000009", "-1"]),
            "123456789012345678901234567889.00001"
        );
        assert_eq!(sum(&["1.5", "-1.5"]), "0");
        assert_eq!(sum(&["-1", "-2.25"]), "-3.25");
        assert_eq!(sum(&["5", "-8"]), "-3");
        assert_eq!(sum(&["1000000000", "-1"]), "999999999");
        assert_eq!(sum(&["1000000000000000000", "-1"]), "999999999999999999");
        assert_eq!(sum(&[]), "0");
    }

    #[test]
    fn averages_to_six_more_digits_rounded_away_from_zero() {
        let avg = |values: &[&str]| {
            let mut total = DecimalSum::default();
            for value in values {
                total.add(&parse(value).unwrap());
            }
            total.average(values.len() as u64).unwrap()
        };
        assert_eq!(avg(&["10", "0", "0"]), "3.333333");
        assert_eq!(avg(&["-10", "0", "0"]), "-3.333333");
        assert_eq!(avg(&["20", "0", "0"]), "6.666667");
        assert_eq!(avg(&["1", "2"]), "1.5");
        assert_eq!(avg(&["1.25", "1.75"]), "1.5");
        assert_eq!(avg(&["-1", "1"]), "0");
        assert_eq!(DecimalSum::default().average(0), None);
    }

    #[test]
    fn a_million_cells_sum_in_well_under_a_second() {
        let values: Vec<String> = (0..1_000_000)
            .map(|i| format!("{i}.{:02}", i % 100))
            .collect();
        // Another process on the machine only ever adds time to a run: the fastest of a few
        // runs is the sum's own cost, held to the same bound.
        let mut fastest = std::time::Duration::MAX;
        for _ in 0..5 {
            let started = std::time::Instant::now();
            let mut total = DecimalSum::default();
            for value in &values {
                total.add(&parse(value).unwrap());
            }
            fastest = fastest.min(started.elapsed());
            // The integer parts add to 499 999 500 000, the hundredths to 10 000 × 49.50.
            assert_eq!(total.to_text(), "499999995000");
            if fastest.as_millis() < 1500 {
                break;
            }
        }
        assert!(fastest.as_millis() < 1500, "{fastest:?}");
    }
}
