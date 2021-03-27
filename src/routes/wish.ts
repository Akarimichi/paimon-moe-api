import { FastifyInstance } from 'fastify';
import XXHash from 'xxhash';
import dayjs from 'dayjs';
import memoize from 'nano-memoize';

import { Banner } from '../entities/banner';
import { Pull } from '../entities/pull';
import { Wish } from '../entities/wish';

import WishDataSchema from '../schemas/wishData.json';
import WishRequestSchema from '../schemas/wishRequest.json';
import { WishRequest } from '../types/wishRequest';
import { WishData } from '../types/wishData';
import { calculateWishTally } from '../services/wish';

export default async function (server: FastifyInstance): Promise<void> {
  const seed = Number(process.env.XXHASH_SEED);

  // cache wish tally result for 1 hour
  const wishMemoized = memoize(calculateWishTally, {
    maxAge: 3600000,
  });

  server.get<{ Querystring: WishRequest }>(
    '/wish',
    {
      schema: {
        querystring: WishRequestSchema,
      },
    },
    async function (req, reply) {
      try {
        const result = await wishMemoized(req.query.banner);
        return result;
      } catch (error) {
        server.log.error(error);
        void reply.status(400);
        throw new Error('invalid banner');
      }
    });

  server.post<{ Body: WishData }>(
    '/wish',
    {
      schema: {
        body: WishDataSchema,
      },
    },
    async function (req, reply) {
      const bannerRepo = this.orm.getRepository(Banner);

      let banner;
      try {
        banner = await bannerRepo.findOneOrFail({ id: req.body.banner });
      } catch (error) {
        server.log.error(error);
        void reply.status(400);
        throw new Error('invalid banner');
      }

      // for identifying same wish, old wishes will be removed first
      const firstWishes = req.body.firstPulls.map(e => e.join(';')).join(';');
      const uniqueId = XXHash.hash(Buffer.from(firstWishes), seed, 'hex');

      const pullRepo = this.orm.getRepository(Pull);

      const pulls: Pull[] = [];
      for (const pull of req.body.legendaryPulls) {
        if (!Array.isArray(pull)) {
          void reply.status(400);
          throw new Error('invalid wish data');
        }

        pulls.push(pullRepo.create({
          time: dayjs.unix(pull[0]).format('YYYY-MM-DD HH:mm:ss+8'),
          name: pull[1],
          type: pull[2],
          pity: pull[3],
          grouped: pull[4],
          banner,
        }));
      }

      const wishRepo = this.orm.getRepository(Wish);

      const savedWish = await wishRepo.findOne({ where: { uniqueId } });

      const wish = wishRepo.create({
        banner,
        uniqueId,
        legendary: req.body.legendary,
        rare: req.body.rare,
        rarePity: req.body.rarePulls,
        total: req.body.total,
        pulls,
      });

      await this.orm.manager.transaction(async transactionalEntityManager => {
        if (savedWish !== undefined) {
          await transactionalEntityManager.remove(savedWish);
        }
        await transactionalEntityManager.save(wish);
      });

      return {
        wish, pulls,
      };
    });
}