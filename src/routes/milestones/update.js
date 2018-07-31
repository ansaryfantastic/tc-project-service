/**
 * API to update a milestone
 */
import validate from 'express-validation';
import _ from 'lodash';
import moment from 'moment';
import Joi from 'joi';
import Sequelize from 'sequelize';
import { middleware as tcMiddleware } from 'tc-core-library-js';
import util from '../../util';
import validateTimeline from '../../middlewares/validateTimeline';
import { EVENT } from '../../constants';
import models from '../../models';

const permissions = tcMiddleware.permissions;

/**
 * Cascades endDate/completionDate changes to all milestones with a greater order than the given one.
 * @param {Object} updatedMilestone the milestone that was updated
 * @returns {Promise<void>} a promise
 */
function updateComingMilestones(updatedMilestone) {
  return models.Milestone.findAll({
    where: {
      timelineId: updatedMilestone.timelineId,
      order: { $gt: updatedMilestone.order },
    },
  }).then((affectedMilestones) => {
    const comingMilestones = _.sortBy(affectedMilestones, 'order');
    let startDate = moment.utc(updatedMilestone.completionDate
      ? updatedMilestone.completionDate
      : updatedMilestone.endDate).add(1, 'days').toDate();
    const promises = _.map(comingMilestones, (_milestone) => {
      const milestone = _milestone;
      if (milestone.startDate.getTime() !== startDate.getTime()) {
        milestone.startDate = startDate;
        milestone.endDate = moment.utc(startDate).add(milestone.duration - 1, 'days').toDate();
      }
      startDate = moment.utc(milestone.completionDate
        ? milestone.completionDate
        : milestone.endDate).add(1, 'days').toDate();
      return milestone.save();
    });
    return Promise.all(promises);
  });
}

const schema = {
  params: {
    timelineId: Joi.number().integer().positive().required(),
    milestoneId: Joi.number().integer().positive().required(),
  },
  body: {
    param: Joi.object().keys({
      id: Joi.any().strip(),
      name: Joi.string().max(255).optional(),
      description: Joi.string().max(255),
      duration: Joi.number().integer().min(1).optional(),
      startDate: Joi.any().forbidden(),
      endDate: Joi.any().forbidden(),
      completionDate: Joi.date().allow(null),
      status: Joi.string().max(45).optional(),
      type: Joi.string().max(45).optional(),
      details: Joi.object(),
      order: Joi.number().integer().optional(),
      plannedText: Joi.string().max(512).optional(),
      activeText: Joi.string().max(512).optional(),
      completedText: Joi.string().max(512).optional(),
      blockedText: Joi.string().max(512).optional(),
      hidden: Joi.boolean().optional(),
      createdAt: Joi.any().strip(),
      updatedAt: Joi.any().strip(),
      deletedAt: Joi.any().strip(),
      createdBy: Joi.any().strip(),
      updatedBy: Joi.any().strip(),
      deletedBy: Joi.any().strip(),
    }).required(),
  },
};

module.exports = [
  validate(schema),
  // Validate and get projectId from the timelineId param,
  // and set to request params for checking by the permissions middleware
  validateTimeline.validateTimelineIdParam,
  permissions('milestone.edit'),
  (req, res, next) => {
    const where = {
      timelineId: req.params.timelineId,
      id: req.params.milestoneId,
    };
    const entityToUpdate = _.assign(req.body.param, {
      updatedBy: req.authUser.userId,
      timelineId: req.params.timelineId,
    });

    let original;
    let updated;

    return models.sequelize.transaction(() =>
      // Find the milestone
      models.Milestone.findOne({ where })
        .then((milestone) => {
          // Not found
          if (!milestone) {
            const apiErr = new Error(`Milestone not found for milestone id ${req.params.milestoneId}`);
            apiErr.status = 404;
            return Promise.reject(apiErr);
          }

          if (entityToUpdate.completionDate && entityToUpdate.completionDate < milestone.startDate) {
            const apiErr = new Error('The milestone completionDate should be greater or equal than the startDate.');
            apiErr.status = 422;
            return Promise.reject(apiErr);
          }

          original = _.omit(milestone.toJSON(), ['deletedAt', 'deletedBy']);

          // Merge JSON fields
          entityToUpdate.details = util.mergeJsonObjects(milestone.details, entityToUpdate.details);

          if (entityToUpdate.duration && entityToUpdate.duration !== milestone.duration) {
            entityToUpdate.endDate = moment.utc(milestone.startDate).add(entityToUpdate.duration - 1, 'days').toDate();
          }

          // Update
          return milestone.update(entityToUpdate);
        })
        .then((updatedMilestone) => {
          // Omit deletedAt, deletedBy
          updated = _.omit(updatedMilestone.toJSON(), 'deletedAt', 'deletedBy');

          // Update order of the other milestones only if the order was changed
          if (original.order === updated.order) {
            return Promise.resolve();
          }

          return models.Milestone.count({
            where: {
              timelineId: updated.timelineId,
              id: { $ne: updated.id },
              order: updated.order,
            },
          })
            .then((count) => {
              if (count === 0) {
                return Promise.resolve();
              }

              // Increase the order from M to K: if there is an item with order K,
              // orders from M+1 to K should be made M to K-1
              if (original.order < updated.order) {
                return models.Milestone.update({ order: Sequelize.literal('"order" - 1') }, {
                  where: {
                    timelineId: updated.timelineId,
                    id: { $ne: updated.id },
                    order: { $between: [original.order + 1, updated.order] },
                  },
                });
              }

              // Decrease the order from M to K: if there is an item with order K,
              // orders from K to M-1 should be made K+1 to M
              return models.Milestone.update({ order: Sequelize.literal('"order" + 1') }, {
                where: {
                  timelineId: updated.timelineId,
                  id: { $ne: updated.id },
                  order: { $between: [updated.order, original.order - 1] },
                },
              });
            });
        })
        .then(() => {
          // Update dates of the other milestones only if the completionDate nor the duration changed
          if (((!original.completionDate && !updated.completionDate) ||
            (original.completionDate && updated.completionDate &&
              original.completionDate.getTime() === updated.completionDate.getTime())) &&
            original.duration === updated.duration) {
            return Promise.resolve();
          }
          return updateComingMilestones(updated);
        }),
    )
    .then(() => {
      // Send event to bus
      req.log.debug('Sending event to RabbitMQ bus for milestone %d', updated.id);
      req.app.services.pubsub.publish(EVENT.ROUTING_KEY.MILESTONE_UPDATED,
        { original, updated },
        { correlationId: req.id },
      );

      // Do not send events for the the other milestones (updated order) here,
      // because it will make 'version conflict' error in ES.
      // The order of the other milestones need to be updated in the MILESTONE_UPDATED event above

      // Write to response
      res.json(util.wrapResponse(req.id, updated));
      return Promise.resolve();
    })
    .catch(next);
  },
];
