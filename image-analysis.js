export function bandsAreRepeated(first, second) {
  if (!(first instanceof Uint8ClampedArray) || first.length !== second?.length || first.length === 0) {
    return false;
  }

  let samePixels = 0;
  let difference = 0;
  const pixels = first.length / 4;
  for (let index = 0; index < first.length; index += 4) {
    const red = Math.abs(first[index] - second[index]);
    const green = Math.abs(first[index + 1] - second[index + 1]);
    const blue = Math.abs(first[index + 2] - second[index + 2]);
    const alpha = Math.abs(first[index + 3] - second[index + 3]);
    const largest = Math.max(red, green, blue, alpha);
    if (largest <= 8) samePixels += 1;
    difference += red + green + blue + alpha;
  }

  const sameRatio = samePixels / pixels;
  const meanDifference = difference / (pixels * 4);
  return sameRatio >= 0.985 && meanDifference <= 2;
}
