export function createRedactor(values) {
  const secrets = [...new Set(
    values.filter((value) => typeof value === "string" && value.length > 0),
  )].sort((left, right) => right.length - left.length);

  return (value) => {
    let output = String(value);
    for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
    return output;
  };
}
