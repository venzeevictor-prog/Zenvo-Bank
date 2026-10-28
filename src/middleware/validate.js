export const validate = (schema, part = 'body') => (req, _res, next) => {
  req[part === 'query' ? 'validatedQuery' : 'validated'] = schema.parse(req[part]);
  next();
};
