import { authWithHeaders } from '../../middlewares/api-v3/auth';
import cron from '../../middlewares/api-v3/cron';
import { model as User } from '../../models/user';
import {
  NotFound,
  NotAuthorized,
} from '../../libs/api-v3/errors';
import _ from 'lodash';

let api = {};

/**
 * @api {get} /hall/patrons Get all Patrons. Only the first 50 patrons are returned. More can be accessed passing ?page=n.
 * @apiVersion 3.0.0
 * @apiName GetPatrons
 * @apiGroup Hall
 *
 * @apiParam {Number} page The result page. Default is 0
 *
 * @apiSuccess {Array} patron An array of patrons
 */
api.getPatrons = {
  method: 'GET',
  url: '/hall/patrons',
  middlewares: [authWithHeaders(), cron],
  async handler (req, res) {
    req.checkQuery('page', res.t('pageMustBeNumber')).optional().isNumeric();

    let validationErrors = req.validationErrors();
    if (validationErrors) throw validationErrors;

    let page = req.query.page ? Number(req.query.page) : 0;
    const perPage = 50;

    let patrons = await User
    .find({
      'backer.tier': {$gt: 0},
    })
    .select('contributor backer profile.name')
    .sort('-backer.tier')
    .skip(page * perPage)
    .limit(perPage)
    .lean()
    .exec();

    res.respond(200, patrons);
  },
};

/**
 * @api {get} /hall/heroes Get all Heroes
 * @apiVersion 3.0.0
 * @apiName GetHeroes
 * @apiGroup Hall
 *
 * @apiSuccess {Array} hero An array of heroes
 */
api.getHeroes = {
  method: 'GET',
  url: '/hall/heroes',
  middlewares: [authWithHeaders(), cron],
  async handler (req, res) {
    let heroes = await User
    .find({
      'contributor.level': {$gt: 0},
    })
    .select('contributor backer profile.name')
    .sort('-contributor.level')
    .lean()
    .exec();

    res.respond(200, heroes);
  },
};

// Note, while the following routes are called getHero / updateHero
// they can be used by admins to get/update any user
// TODO rename?

const heroAdminFields = 'contributor balance profile.name purchased items auth';

/**
 * @api {get} /hall/heroes/:heroId Get an hero given his _id. Must be an admin to make this request
 * @apiVersion 3.0.0
 * @apiName GetHero
 * @apiGroup Hall
 *
 * @apiSuccess {Object} hero The hero object
 */
api.getHero = {
  method: 'GET',
  url: '/hall/heroes/:heroId',
  middlewares: [authWithHeaders(), cron],
  async handler (req, res) {
    let user = res.locals.user;
    let heroId = req.params.heroId;

    req.checkParams('heroId', res.t('heroIdRequired')).notEmpty().isUUID();

    let validationErrors = req.validationErrors();
    if (validationErrors) throw validationErrors;

    if (!user.contributor.admin) {
      throw new NotAuthorized(res.t('noAdminAccess'));
    }

    let hero = await User
      .findById(heroId)
      .select(heroAdminFields)
      .exec();

    if (!hero) throw new NotFound(res.t('userWithIDNotFound', {userId: heroId}));
    let heroRes = hero.toJSON({minimize: true});
    // supply to the possible absence of hero.contributor
    // if we didn't pass minimize: true it would have returned all fields as empty
    if (!heroRes.contributor) heroRes.contributor = {};
    res.respond(200, heroRes);
  },
};

// e.g., tier 5 gives 4 gems. Tier 8 = moderator. Tier 9 = staff
const gemsPerTier = {1: 3, 2: 3, 3: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 0, 9: 0};

/**
 * @api {put} /hall/heroes/:heroId Update an hero. Must be an admin to make this request
 * @apiVersion 3.0.0
 * @apiName UpdateHero
 * @apiGroup Hall
 *
 * @apiSuccess {Object} hero The updated hero object
 */
api.updateHero = {
  method: 'PUT',
  url: '/hall/heroes/:heroId',
  middlewares: [authWithHeaders(), cron],
  async handler (req, res) {
    let user = res.locals.user;
    let heroId = req.params.heroId;
    let updateData = req.body;

    req.checkParams('heroId', res.t('heroIdRequired')).notEmpty().isUUID();

    let validationErrors = req.validationErrors();
    if (validationErrors) throw validationErrors;

    if (!user.contributor.admin) {
      throw new NotAuthorized(res.t('noAdminAccess'));
    }

    let hero = await User.findById(heroId).exec();
    if (!hero) throw new NotFound(res.t('userWithIDNotFound', {userId: heroId}));

    if (updateData.balance) hero.balance = updateData.balance;

    // give them gems if they got an higher level
    let newTier = updateData.contributor && updateData.contributor.level; // tier = level in this context
    let oldTier = hero.contributor && hero.contributor.level || 0;
    if (newTier > oldTier) {
      hero.flags.contributor = true;
      let tierDiff = newTier - oldTier; // can be 2+ tier increases at once
      while (tierDiff) {
        hero.balance += gemsPerTier[newTier] / 4; // balance is in $
        tierDiff--;
        newTier--; // give them gems for the next tier down if they weren't aready that tier
      }
    }

    if (updateData.contributor) _.assign(hero.contributor, updateData.contributor);
    if (updateData.purchased && updateData.purchased.ads) hero.purchased.ads = updateData.purchased.ads;

    // give them the Dragon Hydra pet if they're above level 6
    if (hero.contributor.level >= 6) hero.items.pets['Dragon-Hydra'] = 5;
    if (updateData.itemPath && updateData.itemVal &&
        updateData.itemPath.indexOf('items.') === 0 &&
        User.schema.paths[updateData.itemPath]) {
      _.set(hero, updateData.itemPath, updateData.itemVal); // Sanitization at 5c30944 (deemed unnecessary) TODO review
    }

    if (updateData.auth && _.isBoolean(updateData.auth.blocked)) hero.auth.blocked = updateData.auth.blocked;

    let savedHero = await hero.save();
    let heroJSON = savedHero.toJSON();
    let responseHero = {_id: heroJSON._id}; // only respond with important fields
    heroAdminFields.split(' ').forEach(field => {
      _.set(responseHero, field, _.get(heroJSON, field));
    });

    res.respond(200, responseHero);
  },
};

export default api;