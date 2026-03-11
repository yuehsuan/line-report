export function parseDeployArgs(args) {
  const normalizedArgs = args[0] === '--stacks' ? args.slice(1) : args;
  const hasStackNames = normalizedArgs.some((arg) => !arg.startsWith('--'));
  const requestedStacks = normalizedArgs.filter((arg) => !arg.startsWith('--'));

  return {
    normalizedArgs,
    hasStackNames,
    requestedStacks,
  };
}
