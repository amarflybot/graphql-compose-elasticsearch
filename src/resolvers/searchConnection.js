/* @Flow */

import { Resolver, TypeComposer } from 'graphql-compose';
import { getTypeName, getOrSetType } from '../utils';

export default function createSearchConnectionResolver(
  searchResolver: Resolver<*, *>,
  opts: mixed = {}
): Resolver<*, *> {
  const resolver = searchResolver.clone({
    name: `searchConnection`,
  });

  resolver
    .addArgs({
      first: 'Int',
      after: 'String',
      last: 'Int',
      before: 'String',
    })
    .removeArg(['limit', 'skip'])
    .reorderArgs([
      'q',
      'query',
      'sort',
      'aggs',
      'first',
      'after',
      'last',
      'before',
    ]);

  const searchType = searchResolver.getTypeComposer();
  const typeName = searchType.getTypeName();
  resolver.setType(
    searchType
      .clone(`${typeName}Connection`)
      .addFields({
        pageInfo: getPageInfoTC(opts),
        edges: [
          TypeComposer.create({
            name: `${typeName}Edge`,
            fields: {
              node: searchType.get('hits'),
              cursor: 'String!',
            },
          }),
        ],
      })
      .removeField('hits')
      .reorderFields(['count', 'pageInfo', 'edges', 'aggregations'])
  );

  resolver.resolve = async rp => {
    const { args = {}, projection = {} } = rp;

    if (!args.sort || !Array.isArray(args.sort) || args.sort.length === 0) {
      throw new Error(
        'Argument `sort` is required for the Relay Connection. According to ' +
          'the fields in `sort` will be constructed `cursor`s for every edge. ' +
          'Values of fields which used in `sort` should be unique in compound.'
      );
    }

    const first = parseInt(args.first, 10) || 0;
    if (first < 0) {
      throw new Error('Argument `first` should be non-negative number.');
    }
    const last = parseInt(args.last, 10) || 0;
    if (last < 0) {
      throw new Error('Argument `last` should be non-negative number.');
    }
    const { before, after } = args;
    delete args.before;
    delete args.after;
    if (before !== undefined) {
      throw new Error('Elastic does not support before cursor.');
    }
    if (after) {
      if (!args.body) args.body = {};
      const tmp = cursorToData(after);
      if (Array.isArray(tmp)) {
        args.body.search_after = tmp;
      }
    }

    const limit = last || first || 20;
    const skip = last > 0 ? first - last : 0;

    delete args.last;
    delete args.first;
    args.limit = limit + 1; // +1 document, to check next page presence
    args.skip = skip;

    if (projection.edges) {
      projection.hits = projection.edges.node;
      delete projection.edges;
    }

    const res = await searchResolver.resolve(rp);

    let list = res.hits || [];

    const hasExtraRecords = list.length > limit;
    if (hasExtraRecords) list = list.slice(0, limit);
    const cursorMap = new Map();
    const edges = list.map(node => {
      const cursor = dataToCursor(node.sort);
      if (cursorMap.has(cursor)) {
        throw new Error(
          'Argument `sort` should be more complex. `cursor` are constructed ' +
            'according to the sort fields. Detected that two records have ' +
            `the same cursors '${cursor}' with data '${unbase64(cursor)}'. ` +
            'You should add more `sort` fields, which provide unique data ' +
            'for all cursors in the result set (eg. `id` field).'
        );
      }
      cursorMap.set(cursor, node);
      return { node, cursor };
    });
    const result = {
      ...res,
      pageInfo: {
        hasNextPage: limit > 0 && hasExtraRecords,
        hasPreviousPage: false, // Elastic does not support before cursor
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
      },
      edges,
    };

    return result;
  };

  return resolver;
}

function getPageInfoTC(opts: mixed = {}): TypeComposer {
  const name = getTypeName('PageInfo', opts);

  return getOrSetType(name, () =>
    TypeComposer.create(
      `
      # Information about pagination in a connection.
      type ${name} {
        # When paginating forwards, are there more items?
        hasNextPage: Boolean!

        # When paginating backwards, are there more items?
        hasPreviousPage: Boolean!

        # When paginating backwards, the cursor to continue.
        startCursor: String

        # When paginating forwards, the cursor to continue.
        endCursor: String
      }
    `
    ));
}

export function base64(i: string): string {
  return new Buffer(i, 'ascii').toString('base64');
}

export function unbase64(i: string): string {
  return new Buffer(i, 'base64').toString('ascii');
}

export function cursorToData(cursor: string): mixed {
  if (typeof cursor === 'string') {
    try {
      return JSON.parse(unbase64(cursor)) || null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

export function dataToCursor(data: mixed): string {
  if (!data) return '';
  return base64(JSON.stringify(data));
}
